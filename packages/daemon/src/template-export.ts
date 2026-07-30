import { closeSync, existsSync, openSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  TemplateBundleSchema,
  type AtomNode,
  type JsonValue,
  type Space,
  type SurfaceTemplate,
  type TemplateBundle,
} from '@veduta/protocol'
import type { SpacesEngine } from './spaces-engine.ts'
import { untrustedOrigin } from './taint.ts'
import { sanitizeImportedTemplate, treeSignature, walkAtomTree } from './templates.ts'

/**
 * Export/import of a Space's Templates as a portable JSON bundle
 * (issues/022-emergent-templates.md; docs/adr/0012-emergent-templates.md).
 * `exportTemplates` and `planTemplateImport` are read-only; `applyTemplateImport`
 * is the one write path, and it follows the import discipline recorded in
 * ADR-0012: preview-first, refusal with the exact next command instead of a
 * silent skip, no `--overwrite`, an exclusive lock held across the collision
 * re-check and the writes, an exclusive-create write for each Template
 * (`SpacesEngine.saveTemplate`'s `exclusive` mode) so a file that appears
 * between the collision re-check and this loop's own write fails loudly
 * instead of being silently overwritten, and rollback of whatever this
 * import already wrote if a later write in the same bundle fails.
 */

const TEMPLATES_IMPORT_LOCK_FILE = 'templates.import.lock'

/** The read-only outcome of validating an imported bundle: nothing on disk changes. */
export interface TemplateImportPlan {
  spaceId: string
  source: string
  templates: SurfaceTemplate[]
  /** Ids that already exist in `spaceId` — a non-empty list makes `applyTemplateImport` refuse. */
  collisions: string[]
  /** Total `agent`-path actions removed across every Template in the bundle. */
  strippedAgentActions: number
  /**
   * One block per Template — id, name, intent, the tree's structural
   * signature (`treeSignature(template.tree)`, computed fresh — never a
   * persisted field a bundle could forge), `dataProps`, and every surviving
   * prop value (not only text props) — so the user sees exactly what would
   * land before anything is written. Every rendered field is run through
   * `collapseControlChars` first, so a Template's own strings can never
   * fabricate extra lines in this preview.
   */
  previewLines: string[]
}

/**
 * Thrown by `applyTemplateImport` when one or more Template ids already
 * exist in the destination Space. There is no `--overwrite`: the message
 * names every colliding id, the exact file it sits at, and the exact `rm`
 * command that clears it, so a re-run of the same import then succeeds.
 */
export class TemplateImportRefusal extends Error {
  constructor(
    message: string,
    readonly collisions: string[],
  ) {
    super(message)
    this.name = 'TemplateImportRefusal'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function requireSpace(engine: SpacesEngine, spaceId: string): Space {
  const space = engine.getSpace(spaceId)
  if (!space) throw new Error(`unknown Space: ${spaceId}`)
  return space
}

function checkCollisions(engine: SpacesEngine, spaceId: string, ids: string[]): string[] {
  return ids.filter((id) => engine.getTemplate(spaceId, id) !== undefined)
}

function collisionRefusalMessage(engine: SpacesEngine, spaceId: string, ids: string[]): string {
  const lines = ids.map((id) => `  - ${id} at ${engine.templateFilePath(spaceId, id)}`)
  const removeCommands = ids.map((id) => `  rm '${engine.templateFilePath(spaceId, id)}'`)
  return [
    `import refused: ${ids.length} Template id(s) already exist in this Space and would be overwritten:`,
    ...lines,
    '',
    'there is no --overwrite: remove the colliding file(s), then re-run the import:',
    ...removeCommands,
  ].join('\n')
}

/**
 * Every Template of `spaceId`, sorted by id so two exports of the same
 * state are byte-identical apart from `exportedAt`. `spaceId` is mandatory:
 * a Template id is unique only within its owning Space
 * (`SurfaceTemplateIdSchema` says nothing about cross-Space uniqueness), so
 * flattening every active Space into one bundle can produce two entries
 * sharing an id — a bundle `planTemplateImport` refuses outright
 * (`assertNoDuplicateIds`). There is no "export every Space" mode to paper
 * over that: Templates are Space-owned, so an export names its Space, the
 * same way `import` already requires `--space`.
 */
export function exportTemplates(engine: SpacesEngine, spaceId: string): TemplateBundle {
  const space = requireSpace(engine, spaceId)

  const templates = engine
    .listTemplates(space.id)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return TemplateBundleSchema.parse({
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    templates,
  })
}

/**
 * Cap on how many Template entries a bundle's `"templates"` array may
 * contain, checked in `parseBundleEnvelope` before any entry is sanitized.
 * The CLI's own 1 MiB file-byte cap (`template-cli.ts`'s
 * `TEMPLATE_IMPORT_MAX_BUNDLE_BYTES`) only bounds a bundle read from a file;
 * `planTemplateImport` is also callable directly (e.g. a future non-CLI
 * caller, or a test) with an in-memory `raw` value that never passed through
 * that check, so the array itself needs its own bound.
 */
export const TEMPLATE_IMPORT_MAX_BUNDLE_TEMPLATES = 200

/**
 * Top-level shape check only — never a schema parse of the whole bundle,
 * which would recurse into every Template's `tree` (`AtomNodeSchema` is
 * `z.lazy`) before `sanitizeImportedTemplate`'s iterative caps ever ran.
 * Each entry of the returned array is handed to `sanitizeImportedTemplate`
 * on its own, which enforces the caps before it does anything recursive.
 */
function parseBundleEnvelope(raw: unknown): unknown[] {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('invalid Template bundle: expected a JSON object')
  }
  const bundle = raw as Record<string, unknown>
  if (bundle['formatVersion'] !== 1) {
    throw new Error('invalid Template bundle: unsupported or missing formatVersion')
  }
  if (!Array.isArray(bundle['templates'])) {
    throw new Error('invalid Template bundle: "templates" must be an array')
  }
  if (bundle['templates'].length > TEMPLATE_IMPORT_MAX_BUNDLE_TEMPLATES) {
    throw new Error(
      `invalid Template bundle: "templates" has ${bundle['templates'].length} entries, over the ` +
        `${TEMPLATE_IMPORT_MAX_BUNDLE_TEMPLATES}-entry cap`,
    )
  }
  return bundle['templates']
}

/**
 * Refuses a bundle carrying two Templates with the same id: `checkCollisions`
 * only ever compares against what is already on disk, so without this check
 * a bundle importing `tpl-a` twice would silently let the second entry
 * overwrite the first mid-import, defeating "there is no `--overwrite`" from
 * the inside rather than at the disk boundary it is meant to guard.
 */
function assertNoDuplicateIds(templates: SurfaceTemplate[]): void {
  const seen = new Set<string>()
  for (const template of templates) {
    if (seen.has(template.id)) {
      throw new Error(
        `invalid Template bundle: id "${template.id}" appears more than once in the bundle`,
      )
    }
    seen.add(template.id)
  }
}

/**
 * Collapses every C0/C1 control character — a raw newline, `\r`, a tab, ...
 * — to a single space. Applied to every string this module renders into the
 * CLI's import preview, so a Template's own `name`/`intent`/prop text can
 * never fabricate extra lines in that output: `neutralizeDelimiters`
 * (`sanitizeImportedTemplate`, `taint.ts`) already stops a `<<<` forgery
 * from closing an untrusted-content block, but it does nothing about a
 * literal newline splitting one preview line into several. A run of several
 * control characters collapses to one space, not one per character, so a
 * long run of them cannot pad a forged line either.
 */
function collapseControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  return value.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ')
}

function formatPropValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

/** Every surviving `"<nodeId>.<propKey> = <value>"` line, in document order (root first). */
function collectPropLines(node: AtomNode): string[] {
  const lines: string[] = []
  walkAtomTree(node, (current) => {
    if (!current.props) return
    for (const [key, value] of Object.entries(current.props)) {
      lines.push(`${current.id}.${key} = ${formatPropValue(value)}`)
    }
  })
  return lines
}

function buildPreviewLines(template: SurfaceTemplate): string[] {
  const lines: string[] = [
    `Template ${template.id} "${collapseControlChars(template.name)}"`,
    `  intent: ${collapseControlChars(template.intent)}`,
    `  signature: ${treeSignature(template.tree)}`,
    `  dataProps: ${
      template.dataProps.length > 0
        ? template.dataProps.map(collapseControlChars).join(', ')
        : 'none'
    }`,
  ]
  const propLines = collectPropLines(template.tree)
  if (propLines.length > 0) {
    lines.push('  props:')
    for (const line of propLines) lines.push(`    ${collapseControlChars(line)}`)
  }
  return lines
}

/**
 * The read-only half of an import: validates the bundle envelope, sanitizes
 * every entry through `sanitizeImportedTemplate` (whose fixed validation
 * order — caps, id/schema, delimiter neutralization, `agent`-action removal,
 * untrusted origin — is documented on that function, `templates.ts`), refuses
 * a bundle carrying a duplicate id, and reports collisions and a full
 * preview. Writes and creates nothing — every read goes through `engine`,
 * never a second `SpacesEngine` constructed on the side.
 */
export function planTemplateImport(
  engine: SpacesEngine,
  spaceId: string,
  raw: unknown,
  source: string,
): TemplateImportPlan {
  requireSpace(engine, spaceId)
  const rawTemplates = parseBundleEnvelope(raw)

  const templates: SurfaceTemplate[] = []
  let strippedAgentActions = 0

  for (const rawTemplate of rawTemplates) {
    const sanitized = sanitizeImportedTemplate(rawTemplate, source)
    strippedAgentActions += sanitized.strippedAgentActions
    templates.push(sanitized.template)
  }

  assertNoDuplicateIds(templates)
  templates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const collisions = checkCollisions(
    engine,
    spaceId,
    templates.map((template) => template.id),
  )
  const previewLines = templates.flatMap((template) => buildPreviewLines(template))

  return { spaceId, source, templates, collisions, strippedAgentActions, previewLines }
}

function acquireLock(lockPath: string): number {
  try {
    return openSync(lockPath, 'wx')
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      throw new Error(
        `another Template import is already running (lock held at ${lockPath}). If this is ` +
          `stale (a crashed previous run), remove it and retry: rm '${lockPath}'`,
      )
    }
    throw error
  }
}

/** Best-effort deletion of the files this import already wrote; failures are collected, never thrown. */
function rollbackWrittenTemplates(engine: SpacesEngine, spaceId: string, ids: string[]): string[] {
  const failures: string[] = []
  for (const id of ids) {
    try {
      engine.deleteTemplate(spaceId, id)
    } catch (error) {
      failures.push(`${id}: ${errorText(error)}`)
    }
  }
  return failures
}

/**
 * The write half of an import (docs/adr/0012-emergent-templates.md): refuses
 * outright on any collision already visible in `plan.collisions`; otherwise
 * takes an exclusive lock, re-checks collisions against the live Space
 * (never trusting the plan alone — a concurrent import could have written
 * since the plan was built), then writes each Template through
 * `SpacesEngine.saveTemplate({ exclusive: true })` and appends every
 * Template's `template.imported` Event log entry, tracking which ids
 * landed. The exclusive write is a second, independent guard on top of the
 * live re-check immediately above: that re-check and this loop's own write
 * for a given id are still two separate steps, so a save from outside this
 * import (a concurrent pin or harvest — the import lock only ever excludes
 * a second import) could still land on the exact id in the gap between
 * them. An exclusive write turns that race into a loud failure instead of a
 * silent overwrite. Both loops run inside one guarded region: a throw from
 * either a write or an event append triggers a best-effort rollback of every
 * Template this call already wrote before the error is rethrown, so a
 * failed import never leaves a Template file on disk with no matching Event
 * log record — ADR-0003's "the Agent must find user interactions before
 * reasoning about a Space" would otherwise have nothing to find for an
 * import the append step failed to record. Rollback only ever targets an id
 * this call's own write loop pushed onto `imported`, which — because the
 * write is exclusive — can only be an id this import itself just created:
 * a losing race never reaches `imported` in the first place, so rollback
 * never deletes a file some other write path produced.
 */
export function applyTemplateImport(
  engine: SpacesEngine,
  plan: TemplateImportPlan,
): { imported: string[] } {
  requireSpace(engine, plan.spaceId)

  if (plan.collisions.length > 0) {
    throw new TemplateImportRefusal(
      collisionRefusalMessage(engine, plan.spaceId, plan.collisions),
      plan.collisions,
    )
  }

  // `templatesDirPath` creates the directory when an older Space never got
  // one, and keeps the on-disk layout knowledge in `SpacesEngine`
  // (docs/adr/0006-file-based-memory.md).
  const lockPath = join(engine.templatesDirPath(plan.spaceId), TEMPLATES_IMPORT_LOCK_FILE)
  const lockFd = acquireLock(lockPath)

  try {
    const liveCollisions = checkCollisions(
      engine,
      plan.spaceId,
      plan.templates.map((template) => template.id),
    )
    if (liveCollisions.length > 0) {
      throw new TemplateImportRefusal(
        collisionRefusalMessage(engine, plan.spaceId, liveCollisions),
        liveCollisions,
      )
    }

    const imported: string[] = []
    try {
      for (const template of plan.templates) {
        engine.saveTemplate(plan.spaceId, template, { exclusive: true })
        imported.push(template.id)
      }

      const origin = untrustedOrigin(plan.source)
      for (const template of plan.templates) {
        engine.appendEvent(plan.spaceId, {
          type: 'template.imported',
          origin,
          text: `Imported Template "${template.name}" from "${plan.source}"`,
          payload: { templateId: template.id },
        })
      }
    } catch (error) {
      const rollbackFailures = rollbackWrittenTemplates(engine, plan.spaceId, imported)
      const suffix =
        rollbackFailures.length > 0
          ? ` (rollback also failed for: ${rollbackFailures.join(', ')})`
          : ''
      throw new Error(`template import failed: ${errorText(error)}${suffix}`, { cause: error })
    }

    return { imported }
  } finally {
    closeSync(lockFd)
    if (existsSync(lockPath)) unlinkSync(lockPath)
  }
}
