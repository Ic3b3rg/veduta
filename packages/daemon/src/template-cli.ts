import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { quote } from './import-preview-text.ts'
import { SpacesEngine } from './spaces-engine.ts'
import {
  applyTemplateImport,
  exportTemplates,
  planTemplateImport,
  TemplateImportRefusal,
} from './template-export.ts'

/**
 * `pnpm --filter @veduta/daemon templates <list|export|import> [--space <id>]
 * [--file <path>] [--root <dir>] [--apply]` (issues/022-emergent-templates.md;
 * docs/adr/0012-emergent-templates.md). Follows `memory-index-cli.ts`'s shape:
 * injectable `argv`/`env`/`io`, `run` returns an exit code, `main` is gated
 * behind the file-identity check at the bottom so importing this module never
 * executes it. `--root` must point at the daemon's data directory (the same
 * one the Gateway uses, i.e. `VEDUTA_DATA_DIR`) — every command refuses
 * before constructing a `SpacesEngine` when `<root>/spaces` does not already
 * exist, rather than let the engine's constructor fabricate a fresh data
 * root on a typo'd path (docs/adr/0010-importer-trust-and-refusal.md
 * invariant #1).
 *
 * `--space` is mandatory for `export` (like `import`): a Template id is
 * unique only within its owning Space, so `exportTemplates` (`template-export.ts`)
 * has no "every Space" mode to fall back to — `list` alone stays
 * Space-optional, listing every active Space's Templates when omitted.
 *
 * `import` always prints the plan first, whatever the flags — a dry run and
 * an about-to-apply run render identically up to that point, matching
 * `import-cli.ts`'s own preview-first discipline. Nothing is written unless
 * `--apply` is given; without it, the preview's last line is the exact
 * command that would apply it. Every Template a CLI import brings in is
 * untrusted content, so `IMPORT_SOURCE` — not a user-supplied flag — is the
 * fixed origin every CLI-driven import stamps.
 */

export interface CliIo {
  stdout: (line: string) => void
  stderr: (line: string) => void
}

const defaultIo: CliIo = {
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
}

/** Byte cap on a bundle file, checked with `statSync` before the file is ever read: the
 * parse must never see an unbounded file, the same discipline `sanitizeImportedTemplate`
 * (`templates.ts`) applies to a single Template's shape once the bytes are in memory. */
export const TEMPLATE_IMPORT_MAX_BUNDLE_BYTES = 1024 * 1024

/** Every Template a CLI import brings in is untrusted content, regardless of which file it came from. */
const IMPORT_SOURCE = 'template-import'

const USAGE =
  'usage: templates <list|export|import> [--space <id>] [--file <path>] [--root <dir>] [--apply]'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function resolveRootDir(
  flags: Record<string, string | boolean | undefined>,
  env: NodeJS.ProcessEnv,
): string {
  const flagRoot = flags['root']
  return (
    (typeof flagRoot === 'string' ? flagRoot : undefined) ??
    env['VEDUTA_DATA_DIR'] ??
    join(process.cwd(), '.veduta')
  )
}

function stringFlag(
  flags: Record<string, string | boolean | undefined>,
  key: string,
): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function printTemplateList(engine: SpacesEngine, spaceId: string | undefined, io: CliIo): void {
  const spaceIds =
    spaceId !== undefined
      ? [requireSpace(engine, spaceId).id]
      : engine.listSpaces().map((s) => s.id)

  let count = 0
  for (const id of spaceIds) {
    for (const template of engine.listTemplates(id)) {
      count += 1
      io.stdout(
        `${id} ${template.id} "${template.name}" intent="${template.intent}" ` +
          `savedBy=${template.provenance.savedBy} origin=${template.provenance.origin}`,
      )
    }
  }
  if (count === 0) io.stdout('no Templates found')
}

function requireSpace(engine: SpacesEngine, spaceId: string): { id: string } {
  const space = engine.getSpace(spaceId)
  if (!space) throw new Error(`unknown Space: ${spaceId}`)
  return space
}

function buildTemplatesApplyCommand(options: {
  rootDir: string
  spaceId: string
  filePath: string
}): string {
  return (
    `pnpm --filter @veduta/daemon templates import --space ${quote(options.spaceId)} ` +
    `--file ${quote(options.filePath)} --root ${quote(options.rootDir)} --apply`
  )
}

/**
 * Runs one CLI invocation and returns an exit code. `2` marks a refusal (a
 * `--root` whose `spaces/` directory does not exist, a bundle over the byte
 * cap, or a colliding Template id — `TemplateImportRefusal`); `1` marks a
 * usage error or any other failure; `0` is success, including a preview
 * printed without `--apply`.
 */
export async function run(
  argv: string[],
  context: { env?: NodeJS.ProcessEnv; io?: CliIo } = {},
): Promise<number> {
  const env = context.env ?? process.env
  const io = context.io ?? defaultIo

  let parsed: { values: Record<string, string | boolean | undefined>; positionals: string[] }
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        space: { type: 'string' },
        file: { type: 'string' },
        root: { type: 'string' },
        apply: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    io.stderr(errorText(error))
    io.stderr(USAGE)
    return 1
  }

  const [command] = parsed.positionals
  if (command !== 'list' && command !== 'export' && command !== 'import') {
    io.stderr(USAGE)
    return 1
  }

  const rootDir = resolveRootDir(parsed.values, env)
  const spaceId = stringFlag(parsed.values, 'space')
  const filePath = stringFlag(parsed.values, 'file')
  const apply = parsed.values['apply'] === true

  // A missing required flag is a usage error, not a data-root problem:
  // checked before anything below ever looks at the filesystem, so it is
  // reported the same way regardless of whether --root happens to exist.
  // `--space` is mandatory for `export` too: a Template id is unique only
  // within its owning Space, so there is no "every Space" export to fall
  // back to when it is omitted (`exportTemplates`, `template-export.ts`).
  if (command === 'export' && spaceId === undefined) {
    io.stderr('usage: templates export --space <id> [--file <path>] [--root <dir>]')
    return 1
  }
  if (command === 'import' && (spaceId === undefined || filePath === undefined)) {
    io.stderr('usage: templates import --space <id> --file <path> [--root <dir>] [--apply]')
    return 1
  }

  try {
    // `new SpacesEngine` runs `ensureBaseLayout` on construction, which
    // creates `spaces/`, `USER.md` and `SOUL.md` on the spot
    // (docs/adr/0010-importer-trust-and-refusal.md invariant #1: "the dry
    // run is read-only by construction, not by intention"). Without this
    // check, a typo'd `--root` would silently fabricate a brand-new data
    // root here and only then report "unknown Space" — this CLI's own
    // read-only `list`/`export`, and `import` without `--apply`, would
    // otherwise have written to disk despite never being asked to apply
    // anything. A plain `fs` check, exactly like `import-mapping.ts`'s
    // `readTargetState`, keeps this refusal itself read-only.
    const spacesDir = join(rootDir, 'spaces')
    if (!existsSync(spacesDir)) {
      io.stderr(
        `refusing: ${spacesDir} does not exist. This --root does not look like an existing ` +
          "Veduta data directory (check for a typo, or point --root at the daemon's real data " +
          'directory / VEDUTA_DATA_DIR).',
      )
      return 2
    }

    const engine = new SpacesEngine({ rootDir })

    if (command === 'list') {
      printTemplateList(engine, spaceId, io)
      return 0
    }

    if (command === 'export') {
      // spaceId is already known defined (checked above).
      if (spaceId === undefined) {
        throw new Error('internal error: missing --space should have been caught earlier')
      }
      const bundle = exportTemplates(engine, spaceId)
      const text = JSON.stringify(bundle, null, 2)
      if (filePath !== undefined) {
        writeFileSync(filePath, text)
        io.stdout(`wrote bundle to ${filePath}`)
      } else {
        io.stdout(text)
      }
      return 0
    }

    // import — spaceId/filePath are already known defined (checked above).
    if (spaceId === undefined || filePath === undefined) {
      throw new Error('internal error: missing --space/--file should have been caught earlier')
    }

    const size = statSync(filePath).size
    if (size > TEMPLATE_IMPORT_MAX_BUNDLE_BYTES) {
      io.stderr(
        `refusing: ${filePath} is ${size} bytes, over the ${TEMPLATE_IMPORT_MAX_BUNDLE_BYTES}-byte ` +
          'import cap. Split the bundle into smaller files and import them separately.',
      )
      return 2
    }

    const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    const plan = planTemplateImport(engine, spaceId, raw, IMPORT_SOURCE)

    io.stdout(`Import plan for Space "${spaceId}" from ${filePath}:`)
    io.stdout('')
    for (const line of plan.previewLines) io.stdout(line)
    io.stdout('')
    if (plan.collisions.length > 0) {
      io.stdout(
        `${plan.collisions.length} Template id(s) already exist in this Space: ` +
          plan.collisions.join(', '),
      )
      io.stdout('')
    }

    if (!apply) {
      io.stdout('run again with --apply to perform the import:')
      io.stdout(`  ${buildTemplatesApplyCommand({ rootDir, spaceId, filePath })}`)
      return 0
    }

    const result = applyTemplateImport(engine, plan)
    io.stdout(`imported: ${result.imported.join(', ')}`)
    return 0
  } catch (error) {
    if (error instanceof TemplateImportRefusal) {
      io.stderr(error.message)
      return 2
    }
    io.stderr(errorText(error))
    return 1
  }
}

function main(): void {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code
  })
}

if (process.argv[1] && process.argv[1].endsWith('template-cli.ts')) main()
