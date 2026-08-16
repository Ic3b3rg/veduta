import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  SpaceSchema,
  SurfaceSchema,
  SurfaceTemplateIdSchema,
  SurfaceTemplateSchema,
  type JsonObject,
  type Space,
  type Surface,
  type SurfaceTemplate,
} from '@veduta/protocol'
import {
  curateFact,
  demoteFacts as demoteFactsDocument,
  emptyFactsDocument,
  factRecordIds,
  formatFactsMarkdown,
  parseFactsMarkdown,
  searchFacts as searchFactsDocument,
  type CuratorOperation,
  type FactRecord,
  type FactsDocument,
} from './facts.ts'
import { projectFacts } from './facts-projection.ts'
import { defaultRedactor } from './redaction.ts'
import {
  eventsForContext,
  parseSpaceEventLine,
  readEventsFile,
  renderEventForContext,
  splitLogLines,
  type AppendSpaceEventInput,
  type SpaceEvent,
} from './space-events.ts'
import {
  SpaceProposalConflictError,
  SpaceProposalStore,
  type SpaceProposal,
} from './space-proposals.ts'
import type { Origin } from './taint.ts'
import { normalizeIsoInstant } from './timezone.ts'

export { parseSpaceEventLine, renderEventForContext }
export type { AppendSpaceEventInput, SpaceEvent }
export type { SpaceProposal } from './space-proposals.ts'

export interface SpacesEngineOptions {
  rootDir?: string
  now?: () => Date
  seed?: { spaces: Space[]; surfaces: Surface[] }
}

export interface WriteFactResult {
  operation: CuratorOperation
  fact: FactRecord
  previous?: FactRecord
}

/**
 * A memory write as seen by an `onMemoryWrite` observer (issues/021-advanced-memory.md):
 * fired only after an on-disk change actually happened, never for a noop
 * (e.g. `writeFact` restating an already-active fact fires nothing).
 */
export interface MemoryWriteNotice {
  spaceId: string
  kind: 'event' | 'fact'
}

/**
 * One `searchFacts` hit, re-exported at the type used by `facts.ts`'s
 * `searchFacts` so a caller (e.g. `Store.searchFacts`) can tell an active hit
 * from a dormant or superseded one, rather than the state being thrown away
 * on the way out.
 */
export type FactSearchHit = ReturnType<typeof searchFactsDocument>[number]

const SPACE_FILE = 'SPACE.json'
const FACTS_FILE = 'FACTS.md'
const INSTRUCTIONS_FILE = 'INSTRUCTIONS.md'

export const SPACE_GRANULARITY_RULE =
  'Space granularity rule: a Space is a life area; goals belong in Surfaces inside a Space.'

export const ABSTENTION_RULE =
  "If a user asks about something not present in USER, FACTS, INSTRUCTIONS, or recent Event log, say you don't know and do not invent it."

/** ADR-0005: proactivity is timers, not promises to remember. */
export const TIMER_RULE =
  'Every learned deadline or habit arms a timer (arm_timer tool), never "I\'ll remember it": timers are visible Automations the user can switch off.'

export class SpacesEngine {
  readonly rootDir: string
  private readonly now: () => Date
  private readonly proposals: SpaceProposalStore
  private readonly memoryWriteObservers = new Set<(notice: MemoryWriteNotice) => void>()

  constructor(options: SpacesEngineOptions = {}) {
    this.rootDir = options.rootDir ?? defaultDataDir()
    this.now = options.now ?? (() => new Date())
    this.ensureBaseLayout()
    this.proposals = new SpaceProposalStore({
      rootDir: this.rootDir,
      now: this.now,
      accept: (proposal) => {
        this.ensureProposedSpace(proposal)
      },
    })
    if (options.seed && this.listAllSpaces().length === 0) this.seed(options.seed)
  }

  listSpaces(): Space[] {
    return this.listAllSpaces().filter((space) => !space.archived)
  }

  listAllSpaces(): Space[] {
    if (!existsSync(this.spacesDir())) return []
    return readdirSync(this.spacesDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const path = join(this.spacesDir(), entry.name, SPACE_FILE)
        if (!existsSync(path)) return []
        return [SpaceSchema.parse(JSON.parse(readFileSync(path, 'utf8')))]
      })
      .sort((left, right) => left.slug.localeCompare(right.slug))
  }

  getSpace(spaceId: string): Space | undefined {
    return this.listAllSpaces().find((space) => space.id === spaceId)
  }

  createSpace(input: { name: string; slug?: string; instructions?: string }): Space {
    const slug = this.uniqueSlug(input.slug ?? slugify(input.name))
    const space = SpaceSchema.parse({
      id: `spc-${slug}`,
      slug,
      name: input.name.trim(),
      archived: false,
    })
    this.initializeSpace(space, input.instructions)
    this.appendEvent(space.id, {
      type: 'lifecycle',
      text: `Created Space "${space.name}"`,
      origin: 'trusted:system',
    })
    return space
  }

  proposeSpace(input: { name: string; reason: string }): SpaceProposal {
    const slug = this.uniqueSlug(slugify(input.name))
    return this.proposals.create({
      name: input.name.trim(),
      slug,
      spaceId: `spc-${slug}`,
      reason: input.reason.trim(),
    })
  }

  confirmSpaceProposal(proposalId: string, actor: 'trusted:user'): Space {
    const proposal = this.resolveSpaceProposal(proposalId, 'accept', actor)
    if (proposal.status !== 'accepted') {
      throw new Error(`Space proposal ${proposalId} could not be accepted (${proposal.status})`)
    }
    const space = this.getSpace(proposal.spaceId)
    if (!space) throw new Error(`accepted Space proposal ${proposalId} has no Space`)
    return space
  }

  rejectSpaceProposal(proposalId: string, actor: 'trusted:user'): SpaceProposal {
    return this.resolveSpaceProposal(proposalId, 'reject', actor)
  }

  listSpaceProposals(): SpaceProposal[] {
    return this.proposals.list()
  }

  getSpaceProposal(proposalId: string): SpaceProposal | undefined {
    return this.proposals.get(proposalId)
  }

  resolveSpaceProposal(
    proposalId: string,
    resolution: 'accept' | 'reject',
    actor: 'trusted:user',
  ): SpaceProposal {
    return this.proposals.resolve(proposalId, resolution, actor)
  }

  archiveSpace(spaceId: string): Space {
    return this.updateSpace(spaceId, { archived: true }, 'Archived Space')
  }

  restoreSpace(spaceId: string): Space {
    return this.updateSpace(spaceId, { archived: false }, 'Restored Space')
  }

  mergeSpaces(targetSpaceId: string, sourceSpaceId: string): Space {
    if (targetSpaceId === sourceSpaceId) throw new Error('cannot merge a Space into itself')
    const target = this.requireSpace(targetSpaceId)
    const source = this.requireSpace(sourceSpaceId)
    const sourceFacts = this.readFacts(source.id)

    this.mergeActiveFacts(target.id, sourceFacts.active)
    // Dormant facts are still valid, just not injected by default (facts.ts):
    // dropping them on a merge would be destructive forgetting of a fact the
    // user never contradicted, which ARCHITECTURE.md §7 forbids.
    this.copyDormantAndSupersededFacts(target.id, sourceFacts.dormant, sourceFacts.superseded)
    this.moveSurfaces(source.id, target.id)
    this.moveTemplates(source.id, target.id)
    this.archiveSpace(source.id)
    this.appendEvent(target.id, {
      type: 'lifecycle',
      text: `Merged Space "${source.name}" into "${target.name}"`,
      origin: 'trusted:user',
    })
    return this.requireSpace(target.id)
  }

  readFacts(spaceId: string): FactsDocument {
    return parseFactsMarkdown(readFileSync(this.factsPath(this.requireSpace(spaceId)), 'utf8'))
  }

  /**
   * `options.mode: 'conservative'` (issues/021-advanced-memory.md's nightly
   * Reflection) is forwarded verbatim to `curateFact`: the Reflection must
   * never falsely supersede a still-valid fact the way the default mode's
   * topic-similarity heuristic sometimes does (`facts.ts`'s `curateFact`
   * doc comment), so it opts out of that branch entirely rather than this
   * method silently deciding the mode on the caller's behalf. Every
   * existing caller omits `options` and keeps the default mode unchanged.
   */
  writeFact(
    spaceId: string,
    factText: string,
    origin?: Origin,
    options?: { mode?: 'default' | 'conservative' },
  ): WriteFactResult {
    const space = this.requireSpace(spaceId)
    const date = this.today()
    const result = curateFact(this.readFacts(space.id), factText, date, origin, options)
    if (result.operation !== 'noop') {
      writeFileSync(this.factsPath(space), formatFactsMarkdown(result.document, date))
      // Fired after its `fact.write` Event log echo below, not straight
      // after the FACTS write, matching `demoteFacts`: a 'fact' notice means
      // "this write, including the Event log entry that records it, is
      // fully on disk", not just "the FACTS file changed".
      this.appendEvent(space.id, {
        type: 'fact.write',
        text: `FACTS ${result.operation}: ${result.fact.text}`,
        ...(origin === undefined ? {} : { origin }),
      })
      this.notifyMemoryWrite(space.id, 'fact')
    }
    return {
      operation: result.operation,
      fact: result.fact,
      ...(result.previous === undefined ? {} : { previous: result.previous }),
    }
  }

  searchFacts(spaceId: string, query: string): FactSearchHit[] {
    this.requireSpace(spaceId)
    return searchFactsDocument(this.readFacts(spaceId), query)
  }

  /**
   * Moves the active records identified by `ids` (per `factRecordIds`,
   * `facts.ts`) into `## Dormant` and appends a content-free `fact.demote`
   * event carrying the demoted ids and count — ADR-0003: no silent state
   * change, the Agent must be able to find the change in the Event log.
   * Demoting nothing (every id unknown, or `ids` empty) writes nothing and
   * appends nothing: this is the nightly Reflection's non-destructive way of
   * bringing the active set back under budget (issues/021-advanced-memory.md).
   */
  demoteFacts(spaceId: string, ids: string[]): FactRecord[] {
    const space = this.requireSpace(spaceId)
    const date = this.today()
    const document = this.readFacts(space.id)
    const recordIds = factRecordIds(document, date)
    const idSet = new Set(ids)
    const matchedIds = document.active
      .map((fact) => recordIds.get(fact))
      .filter((id): id is string => id !== undefined && idSet.has(id))
    const result = demoteFactsDocument(document, ids, date)
    if (result.demoted.length === 0) return []

    writeFileSync(this.factsPath(space), formatFactsMarkdown(result.document, date))
    this.appendEvent(space.id, {
      type: 'fact.demote',
      text: 'Reflection moved facts to dormant to keep the active set within budget.',
      payload: { ids: matchedIds, count: result.demoted.length },
    })
    // After the `fact.demote` Event log entry above, matching `writeFact`:
    // a 'fact' notice means the whole operation, event echo included, is
    // durable — not merely that `FACTS.md` itself was rewritten.
    this.notifyMemoryWrite(space.id, 'fact')
    return result.demoted
  }

  appendEvent(spaceId: string, input: AppendSpaceEventInput): SpaceEvent {
    const space = this.requireSpace(spaceId)
    const at = input.at ?? this.nowIso()
    const occurredAt = normalizeIsoInstant(input.occurredAt)
    // SECURITY.md §4: no secret ever appears in the Event log. Redaction
    // happens PRE-append (ADR-0003: the log is never rewritten), so a
    // secret that reached this call never lands durably in the first place.
    const event: SpaceEvent = {
      at,
      spaceId: space.id,
      type: input.type ?? 'turn',
      text: defaultRedactor.redactText(input.text),
      origin: input.origin ?? 'trusted:system',
      ...(occurredAt === undefined ? {} : { occurredAt }),
      ...(input.payload === undefined
        ? {}
        : { payload: defaultRedactor.redactDeep(input.payload) as JsonObject }),
    }
    appendFileSync(this.logPath(space, at), `${JSON.stringify(event)}\n`)
    this.notifyMemoryWrite(space.id, 'event')
    return event
  }

  readRecent(spaceId: string, limit = 20): SpaceEvent[] {
    this.requireSpace(spaceId)
    return this.readAllEvents(spaceId).slice(-limit)
  }

  /** Events at or after `sinceIso`, reading only the daily log files that can contain them. */
  readSince(spaceId: string, sinceIso: string): SpaceEvent[] {
    const space = this.requireSpace(spaceId)
    const dir = this.spacePath(space, 'log')
    if (!existsSync(dir)) return []
    const sinceDay = sinceIso.slice(0, 10)
    return readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl') && file.slice(0, 10) >= sinceDay)
      .sort()
      .flatMap((file) => readEventsFile(join(dir, file)))
      .filter((event) => event.at >= sinceIso)
      .sort((left, right) => left.at.localeCompare(right.at))
  }

  searchLog(spaceId: string, query: string, limit = 20): SpaceEvent[] {
    const needle = query.toLowerCase()
    if (!needle) return []
    return this.readAllEvents(spaceId)
      .filter((event) => JSON.stringify(event).toLowerCase().includes(needle))
      .slice(-limit)
  }

  assembleContext(spaceId: string, recentLimit = 20): string {
    const space = this.requireSpace(spaceId)
    const facts = this.readFacts(space.id)
    const recentEvents = this.readRecent(space.id, recentLimit)
    return [
      section('SOUL', readOrEmpty(this.globalPath('SOUL.md'))),
      section('USER', readOrEmpty(this.globalPath('USER.md'))),
      section(
        'Active Space',
        `${space.name} (${space.slug})\n${SPACE_GRANULARITY_RULE}\n${TIMER_RULE}`,
      ),
      section('FACTS', projectFacts(facts).text),
      section('Recent Event log', eventsForContext(recentEvents)),
      section('INSTRUCTIONS', readOrEmpty(this.spacePath(space, INSTRUCTIONS_FILE))),
    ].join('\n\n')
  }

  /**
   * The origins actually feeding a turn's context: the events `assembleContext`
   * reads via `readRecent`, plus the untrusted origins reported by
   * `projectFacts` — the same single traversal that produces the FACTS text
   * injected into that same context, so the two can never disagree about
   * what a turn saw (issues/032-facts-hygiene-context-budget.md). Dormant
   * facts contribute no origin here because `projectFacts` never renders
   * them: a fact that is not injected cannot taint the turn through this
   * path (it can still taint via a tool that retrieves it, gated instead
   * by that tool's own reported origins). Deduplicated. Feeds
   * `gateToolsForOrigins` (docs/SECURITY.md §3.2) so tool gating matches
   * what the Agent can see.
   */
  contextOrigins(spaceId: string, recentLimit = 20): Origin[] {
    const recentEvents = this.readRecent(spaceId, recentLimit)
    const origins = new Set<Origin>()
    for (const event of recentEvents) origins.add(event.origin)
    for (const origin of projectFacts(this.readFacts(spaceId)).origins) origins.add(origin)
    return [...origins]
  }

  /**
   * The two global identity documents (`SOUL.md`, `USER.md`), as
   * `assembleContext` reads them for a Space turn. Global chat (issue #37)
   * has no Space to assemble a full context for, so this is its read seam —
   * kept here rather than letting a caller reconstruct `globalPath`'s file
   * layout for itself, the same reasoning `listLogFiles`/`readLogLine`
   * already follow for the Event log.
   */
  readGlobalDocs(): { soul: string; user: string } {
    return {
      soul: readOrEmpty(this.globalPath('SOUL.md')),
      user: readOrEmpty(this.globalPath('USER.md')),
    }
  }

  saveSurface(surface: Surface): Surface {
    const parsed = SurfaceSchema.parse(surface)
    const space = this.requireSpace(parsed.spaceId)
    writeFileSync(this.surfacePath(space, parsed.id), JSON.stringify(parsed, null, 2))
    return parsed
  }

  listPersistedSurfaces(spaceId?: string): Surface[] {
    const spaces = spaceId ? [this.requireSpace(spaceId)] : this.listAllSpaces()
    return spaces.flatMap((space) => this.readSurfaces(space))
  }

  /**
   * Persists a Template to `spaces/<slug>/templates/<id>.json`
   * (issues/022-emergent-templates.md), mirroring `saveSurface`. A Template
   * has no `spaceId` field of its own (`packages/protocol/src/template.ts`),
   * so the owning Space is the first parameter rather than something read
   * off the object. `id` doubles as the filename, and it is
   * attacker-reachable through the future importer (docs/adr/0006's "files
   * are the truth" cuts both ways), so the containment check happens here at
   * the write, not only inside `SurfaceTemplateIdSchema`'s regex.
   *
   * `options.exclusive` switches the write itself from "create or overwrite"
   * (the ordinary harvest/pin path's intent — `TemplateEngine` always means
   * to write, whether or not something is already there) to "create, and
   * fail if something is already there" at the OS level (`writeTemplateFile`).
   * The importer (`applyTemplateImport`, `template-export.ts`) is the one
   * caller that needs this: it already re-checks for a collision right
   * before writing, but that check and this write are still two separate
   * steps, and a save from anywhere else in the daemon — a concurrent pin or
   * harvest, never another import, since the import lock only ever excludes
   * a second import — could land on the exact id in between. Without
   * exclusivity that write would silently overwrite the concurrent save, and
   * a later rollback in the same import would then delete a file this
   * import never actually created, destroying the other write's content
   * instead of merely leaving its own mess behind.
   */
  saveTemplate(
    spaceId: string,
    template: SurfaceTemplate,
    options: { exclusive?: boolean } = {},
  ): SurfaceTemplate {
    const parsed = SurfaceTemplateSchema.parse(template)
    const space = this.requireSpace(spaceId)
    const path = this.templatePath(space, parsed.id)
    this.assertTemplateContainment(space, path, parsed.id)
    // A Space created before Templates existed has no `templates/` directory:
    // `initializeSpace` only runs at creation, so the first save into an older
    // Space would otherwise fail with ENOENT.
    mkdirSync(this.spacePath(space, 'templates'), { recursive: true })
    writeTemplateFile(path, parsed, options.exclusive ?? false)
    return parsed
  }

  /**
   * The Space's `templates/` directory, created if an older Space never got
   * one. Exported so the Template importer can put its lock file beside the
   * Templates without a second copy of the on-disk layout
   * (docs/adr/0006-file-based-memory.md keeps that knowledge here).
   */
  templatesDirPath(spaceId: string): string {
    const space = this.requireSpace(spaceId)
    const dir = this.spacePath(space, 'templates')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** Where `templateId` lives on disk, for a message or a rollback. Same containment check as `saveTemplate`. */
  templateFilePath(spaceId: string, templateId: string): string {
    const space = this.requireSpace(spaceId)
    const path = this.templatePath(space, templateId)
    this.assertTemplateContainment(space, path, templateId)
    return path
  }

  /**
   * Removes one Template file. The importer's rollback is the only caller:
   * a partially written bundle must leave the Space as it was
   * (issues/022-emergent-templates.md). A missing file is a no-op.
   */
  deleteTemplate(spaceId: string, templateId: string): void {
    const path = this.templateFilePath(spaceId, templateId)
    if (existsSync(path)) unlinkSync(path)
  }

  /**
   * `[]` for a Space created before this change, which has no `templates/`
   * directory yet. A file that fails to parse as JSON, or as a valid
   * `SurfaceTemplate`, is skipped with a `console.warn` naming its path
   * rather than thrown: files are the truth (docs/adr/0006-file-based-memory.md),
   * but one hand-edited or corrupted Template must not take down every
   * gated `create_surface` call in the Space, which reads this list.
   */
  listTemplates(spaceId: string): SurfaceTemplate[] {
    const space = this.requireSpace(spaceId)
    const dir = this.spacePath(space, 'templates')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .flatMap((file) => {
        const path = join(dir, file)
        let raw: unknown
        try {
          raw = JSON.parse(readFileSync(path, 'utf8'))
        } catch (error) {
          console.warn(`skipping unreadable Template file ${path}: ${errorText(error)}`)
          return []
        }
        const result = SurfaceTemplateSchema.safeParse(raw)
        if (!result.success) {
          console.warn(`skipping invalid Template file ${path}: ${result.error.message}`)
          return []
        }
        return [result.data]
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  }

  /** `undefined` when absent. Same containment check as `saveTemplate`. */
  getTemplate(spaceId: string, templateId: string): SurfaceTemplate | undefined {
    const space = this.requireSpace(spaceId)
    const path = this.templatePath(space, templateId)
    this.assertTemplateContainment(space, path, templateId)
    if (!existsSync(path)) return undefined
    return SurfaceTemplateSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  }

  factsSurface(spaceId: string): Surface {
    const space = this.requireSpace(spaceId)
    const facts = this.readFacts(space.id)
    const factNodes =
      facts.active.length === 0
        ? [{ id: 'no-facts', type: 'Caption' as const, props: { text: 'No facts noted yet.' } }]
        : facts.active.map((fact, index) => ({
            id: `fact-${index + 1}`,
            type: 'Text' as const,
            props: { text: `- ${fact.text} (noted: ${fact.noted ?? 'undated'})` },
          }))

    return SurfaceSchema.parse({
      id: `srf-${space.slug}-facts`,
      spaceId: space.id,
      title: 'What I know about you here',
      // Regenerated on every read from FACTS.md, never a tree the user
      // authored, so a pin toggle would be meaningless — the client must not
      // offer it (issues/022-emergent-templates.md).
      pinnable: false,
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          { id: 'title', type: 'Title', props: { text: 'What I know about you here' } },
          ...factNodes,
          {
            id: 'edit',
            type: 'Button',
            props: { label: 'Edit facts' },
            actions: [{ name: 'edit_facts', path: 'agent', payload: { spaceId: space.id } }],
          },
        ],
      },
      state: {},
      freshness: {
        updatedAt: fileMtimeIso(this.factsPath(space), this.nowIso()),
        updatedBy: 'system',
      },
    })
  }

  /**
   * Read seam for the memory index (issues/021-advanced-memory.md):
   * `SpacesEngine` stays the only module that knows where a Space's files
   * live on disk (docs/adr/0006-file-based-memory.md) — the index reads log
   * files through this and the following methods instead of duplicating the
   * on-disk layout.
   *
   * The `*.jsonl` files of a Space's `log/` directory, sorted by name, with
   * each file's current byte length. Empty array when the directory does
   * not exist (a Space with no Event log yet).
   */
  listLogFiles(spaceId: string): { file: string; bytes: number }[] {
    const space = this.requireSpace(spaceId)
    const dir = this.spacePath(space, 'log')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .map((file) => ({ file, bytes: statSync(join(dir, file)).size }))
  }

  /**
   * Resumes indexing from a byte/line cursor: reads `file`, skips the first
   * `fromByte` bytes, and returns the entries found after that point with
   * absolute 1-based line numbers continuing from `fromLine`, plus the
   * file's total `bytes` and total `lines` so the caller can store its next
   * cursor. Reads the file as a `Buffer` and slices by bytes (never by
   * decoded characters), so a multi-byte character earlier in the file
   * cannot shift the offset. A line that fails to parse is skipped in
   * `entries` but still counted in `lines` — the numbering must stay
   * aligned with the file, or a later `readLogLine` call would return the
   * wrong line. `fromByte` at or past the current end of file returns no
   * entries and the file's real (possibly smaller) size, so the caller can
   * detect a shrunk or restored log instead of indexing past it.
   */
  readLogEntriesFrom(
    spaceId: string,
    file: string,
    fromByte: number,
    fromLine: number,
  ): { entries: { line: number; raw: string; event: SpaceEvent }[]; bytes: number; lines: number } {
    const space = this.requireSpace(spaceId)
    const path = this.spacePath(space, 'log', file)
    const buffer = existsSync(path) ? readFileSync(path) : Buffer.alloc(0)
    if (fromByte >= buffer.length) {
      return { entries: [], bytes: buffer.length, lines: fromLine }
    }

    const rawLines = splitLogLines(buffer.subarray(fromByte).toString('utf8'))

    const entries: { line: number; raw: string; event: SpaceEvent }[] = []
    let line = fromLine
    for (const raw of rawLines) {
      line += 1
      const event = parseSpaceEventLine(raw)
      // Counted above either way, for line-number alignment: a blank or
      // unparseable line must not shift what a later `readLogLine` call at
      // this line number returns.
      if (event) entries.push({ line, raw, event })
    }

    return { entries, bytes: buffer.length, lines: line }
  }

  /**
   * The raw text of a 1-based line in `file`, or `undefined` when out of
   * range or the file is missing: the dereference path for the memory
   * index, which stores a `(file, line)` reference plus a hash and re-reads
   * the original line to answer with it (issues/021-advanced-memory.md).
   */
  readLogLine(spaceId: string, file: string, line: number): string | undefined {
    const space = this.requireSpace(spaceId)
    const path = this.spacePath(space, 'log', file)
    if (!existsSync(path)) return undefined
    const rawLines = splitLogLines(readFileSync(path, 'utf8'))
    const index = line - 1
    return index >= 0 && index < rawLines.length ? rawLines[index] : undefined
  }

  /**
   * Hex sha256 of the file's first `bytes` bytes. The memory index uses this
   * to notice a restored log file whose content changed at the same
   * length — a size comparison alone cannot see that.
   *
   * Reads only those `bytes` bytes through a file descriptor rather than
   * `readFileSync`-ing the whole file and slicing: `indexSpaceEvents`
   * (`memory-index.ts`) calls this once per unchanged file on every single
   * `appendEvent`, on a Space that can hold many days of log history, so an
   * O(whole file) read here would defeat the point of the byte-cursor
   * comparison that decides whether this file needs reindexing at all.
   */
  readLogPrefixHash(spaceId: string, file: string, bytes: number): string {
    const space = this.requireSpace(spaceId)
    const path = this.spacePath(space, 'log', file)
    if (!existsSync(path) || bytes <= 0) {
      return createHash('sha256').update(Buffer.alloc(0)).digest('hex')
    }
    const fd = openSync(path, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      const bytesRead = readSync(fd, buffer, 0, bytes, 0)
      return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex')
    } finally {
      closeSync(fd)
    }
  }

  /**
   * Fires after a successful `appendEvent` (`'event'`) and after `writeFact`,
   * `demoteFacts`, and the `mergeSpaces` FACTS rewrites (`'fact'`) actually
   * change something on disk — never for a noop. The engine deliberately
   * knows nothing about the memory index (issues/021-advanced-memory.md):
   * the index subscribes here instead, so the file-layout layering in
   * docs/adr/0006-file-based-memory.md holds and no caller has to remember
   * to refresh it. `writeFact` and `demoteFacts` also call `appendEvent`
   * internally, so a single `writeFact` fires one `'fact'` notice and one
   * `'event'` notice — both sources genuinely changed.
   */
  onMemoryWrite(observer: (notice: MemoryWriteNotice) => void): () => void {
    this.memoryWriteObservers.add(observer)
    return () => this.memoryWriteObservers.delete(observer)
  }

  /**
   * Notifies observers after a write already landed on disk. An observer's
   * failure is logged and swallowed, never propagated: the only subscriber is
   * the disposable memory index (issues/021-advanced-memory.md), and by the
   * time this runs the Event log or `FACTS.md` write has committed. Letting a
   * full disk or a corrupt index throw from here would report a *failed*
   * mutation for something that actually succeeded, and every caller —
   * the Gateway's fast path, the importer, the trust layer, the scheduler —
   * would be entitled to retry it and duplicate the write. The index can
   * always be rebuilt from the files; the files cannot be un-written.
   */
  private notifyMemoryWrite(spaceId: string, kind: MemoryWriteNotice['kind']): void {
    for (const observer of this.memoryWriteObservers) {
      try {
        observer({ spaceId, kind })
      } catch (error) {
        console.error('memory write observer failed', error)
      }
    }
  }

  private seed(seed: { spaces: Space[]; surfaces: Surface[] }): void {
    for (const space of seed.spaces) this.initializeSpace(space)
    for (const surface of seed.surfaces) this.saveSurface(surface)
  }

  private ensureProposedSpace(proposal: SpaceProposal): Space {
    const space = SpaceSchema.parse({
      id: proposal.spaceId,
      slug: proposal.slug,
      name: proposal.name,
      archived: false,
    })
    const existing = this.getSpace(space.id)
    if (existing && (existing.slug !== space.slug || existing.name !== space.name)) {
      throw new SpaceProposalConflictError(
        `Space proposal ${proposal.id} conflicts with existing Space ${space.id}`,
      )
    }

    // Re-running initializeSpace repairs a partially initialized directory;
    // writeIfMissing keeps its mutable documents intact.
    this.initializeSpace(space)
    const alreadyRecorded = this.readAllEvents(space.id).some(
      (event) => event.type === 'lifecycle' && event.payload?.['spaceProposalId'] === proposal.id,
    )
    if (!alreadyRecorded) {
      this.appendEvent(space.id, {
        at: proposal.decisionAt ?? this.nowIso(),
        type: 'lifecycle',
        text: `Confirmed Space proposal "${proposal.name}": ${proposal.reason}`,
        origin: 'trusted:user',
        payload: { spaceProposalId: proposal.id },
      })
    }
    return space
  }

  private initializeSpace(space: Space, instructions?: string): void {
    const parsed = SpaceSchema.parse(space)
    mkdirSync(this.spacePath(parsed), { recursive: true })
    mkdirSync(this.spacePath(parsed, 'log'), { recursive: true })
    mkdirSync(this.spacePath(parsed, 'surfaces'), { recursive: true })
    mkdirSync(this.spacePath(parsed, 'templates'), { recursive: true })
    this.writeSpace(parsed)
    writeIfMissing(this.factsPath(parsed), formatFactsMarkdown(emptyFactsDocument(), this.today()))
    writeIfMissing(
      this.spacePath(parsed, INSTRUCTIONS_FILE),
      instructions ?? defaultInstructions(parsed.name),
    )
  }

  private updateSpace(spaceId: string, patch: Pick<Space, 'archived'>, eventText: string): Space {
    const space = this.requireSpace(spaceId)
    const updated = SpaceSchema.parse({ ...space, ...patch })
    this.writeSpace(updated)
    this.appendEvent(updated.id, { type: 'lifecycle', text: eventText, origin: 'trusted:user' })
    return updated
  }

  /**
   * Appends the source Space's dormant and superseded records onto the
   * target's own — neither state is injected into context by default, but
   * both are still valid, on-disk facts (`facts.ts`), so a merge must carry
   * them across rather than dropping them.
   */
  private copyDormantAndSupersededFacts(
    targetSpaceId: string,
    dormant: FactRecord[],
    superseded: FactRecord[],
  ): void {
    if (dormant.length === 0 && superseded.length === 0) return
    const target = this.requireSpace(targetSpaceId)
    const document = this.readFacts(target.id)
    const merged = {
      active: document.active,
      dormant: [...document.dormant, ...dormant],
      superseded: [...document.superseded, ...superseded],
    }
    writeFileSync(this.factsPath(target), formatFactsMarkdown(merged, this.today()))
    this.notifyMemoryWrite(target.id, 'fact')
  }

  private mergeActiveFacts(targetSpaceId: string, facts: FactRecord[]): void {
    if (facts.length === 0) return
    const target = this.requireSpace(targetSpaceId)
    let document = this.readFacts(target.id)
    for (const fact of facts) {
      // A merged fact keeps its origin: a Space merge must never launder
      // an untrusted fact into an unmarked one.
      document = curateFact(document, fact.text, fact.noted ?? this.today(), fact.origin).document
    }
    writeFileSync(this.factsPath(target), formatFactsMarkdown(document, this.today()))
    this.notifyMemoryWrite(target.id, 'fact')
  }

  private moveSurfaces(sourceSpaceId: string, targetSpaceId: string): void {
    const source = this.requireSpace(sourceSpaceId)
    const target = this.requireSpace(targetSpaceId)
    const usedIds = new Set(this.listPersistedSurfaces(target.id).map((surface) => surface.id))
    for (const surface of this.listPersistedSurfaces(sourceSpaceId)) {
      const id = uniqueSurfaceId(surface.id, source.slug, usedIds)
      usedIds.add(id)
      this.saveSurface({ ...surface, id, spaceId: target.id })
    }
  }

  /**
   * Carries the source Space's Templates into the target on a merge, the
   * way `moveSurfaces` carries its Surfaces — de-collided with
   * `uniqueTemplateId` rather than `uniqueSurfaceId`'s rule, since a
   * Template id's grammar is shorter (`SurfaceTemplateIdSchema`).
   */
  private moveTemplates(sourceSpaceId: string, targetSpaceId: string): void {
    const source = this.requireSpace(sourceSpaceId)
    const target = this.requireSpace(targetSpaceId)
    const usedIds = new Set(this.listTemplates(target.id).map((template) => template.id))
    for (const template of this.listTemplates(sourceSpaceId)) {
      const id = uniqueTemplateId(template.id, source.slug, usedIds)
      usedIds.add(id)
      this.saveTemplate(target.id, SurfaceTemplateSchema.parse({ ...template, id }))
    }
  }

  private readSurfaces(space: Space): Surface[] {
    const dir = this.spacePath(space, 'surfaces')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.json'))
      .map((file) => SurfaceSchema.parse(JSON.parse(readFileSync(join(dir, file), 'utf8'))))
      .sort((left, right) => left.title.localeCompare(right.title))
  }

  private readAllEvents(spaceId: string): SpaceEvent[] {
    const space = this.requireSpace(spaceId)
    const dir = this.spacePath(space, 'log')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((file) => file.endsWith('.jsonl'))
      .sort()
      .flatMap((file) => readEventsFile(join(dir, file)))
      .sort((left, right) => left.at.localeCompare(right.at))
  }

  private writeSpace(space: Space): void {
    writeFileSync(this.spacePath(space, SPACE_FILE), JSON.stringify(space, null, 2))
  }

  private requireSpace(spaceId: string): Space {
    const space = this.getSpace(spaceId)
    if (!space) throw new Error(`unknown Space: ${spaceId}`)
    return space
  }

  private uniqueSlug(baseSlug: string): string {
    const base = baseSlug || 'space'
    const existing = new Set([
      ...this.listAllSpaces().map((space) => space.slug),
      ...this.proposals.reservedSlugs(),
    ])
    if (!existing.has(base)) return base
    for (let index = 2; ; index += 1) {
      const candidate = `${base}-${index}`
      if (!existing.has(candidate)) return candidate
    }
  }

  private ensureBaseLayout(): void {
    mkdirSync(this.rootDir, { recursive: true })
    mkdirSync(this.spacesDir(), { recursive: true })
    writeIfMissing(this.globalPath('USER.md'), '# USER\n\n')
    writeIfMissing(this.globalPath('SOUL.md'), defaultSoul())
  }

  private spacesDir(): string {
    return join(this.rootDir, 'spaces')
  }

  private globalPath(file: 'USER.md' | 'SOUL.md'): string {
    return join(this.rootDir, file)
  }

  private spacePath(space: Space, ...parts: string[]): string {
    return join(this.spacesDir(), space.slug, ...parts)
  }

  private factsPath(space: Space): string {
    return this.spacePath(space, FACTS_FILE)
  }

  private surfacePath(space: Space, surfaceId: string): string {
    return this.spacePath(space, 'surfaces', `${surfaceId}.json`)
  }

  private templatePath(space: Space, templateId: string): string {
    return this.spacePath(space, 'templates', `${templateId}.json`)
  }

  /**
   * Refuses a `path` that does not sit directly inside the Space's
   * `templates/` directory. `templateId` becomes a filename
   * (`templatePath`), and it is attacker-reachable through the future
   * importer (issues/022-emergent-templates.md), so this check runs at
   * every read and write instead of trusting `SurfaceTemplateIdSchema`'s
   * regex alone to have already ruled out a traversal.
   *
   * The `resolve`-based check above is purely lexical and never follows a
   * symlink; the write (or the importer rollback's `unlink`) that runs
   * right after this check does, at the OS level. So as defence in depth —
   * kept second, after the cheap lexical gate — when the directory already
   * exists this also resolves its *real*, symlink-followed location and
   * requires it to still be exactly the Space's own real `templates/`
   * directory: a `templates/` directory (or an entry inside it) swapped for
   * a symlink pointing elsewhere would pass the lexical check but land the
   * write, or the rollback delete, somewhere else on disk entirely. A
   * `templates/` directory that does not exist yet (an older Space's first
   * Template save) has nothing to be a symlink of, so there is nothing to
   * check.
   */
  private assertTemplateContainment(space: Space, path: string, templateId: string): void {
    const templatesDir = resolve(this.spacePath(space, 'templates'))
    const resolvedPath = resolve(path)
    if (dirname(resolvedPath) !== templatesDir) {
      throw new Error(`Template id escapes the Space's templates directory: ${templateId}`)
    }

    if (existsSync(templatesDir)) {
      const realTemplatesDir = realpathSync(templatesDir)
      const realSpaceDir = realpathSync(this.spacePath(space))
      if (realTemplatesDir !== join(realSpaceDir, 'templates')) {
        throw new Error(`Template id escapes the Space's templates directory: ${templateId}`)
      }
    }
  }

  private logPath(space: Space, at: string): string {
    return this.spacePath(space, 'log', `${at.slice(0, 10)}.jsonl`)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private today(): string {
    return this.nowIso().slice(0, 10)
  }
}

function defaultDataDir(): string {
  if (process.env['VITEST'] || process.env['NODE_ENV'] === 'test') {
    return mkdtempSync(join(tmpdir(), 'veduta-spaces-'))
  }
  return join(process.cwd(), '.veduta')
}

/**
 * `saveTemplate`'s actual write. `exclusive` picks between a plain
 * create-or-overwrite (`writeFileSync`, today's behaviour, unchanged for the
 * harvest/pin path) and an OS-level exclusive create: `O_WRONLY | O_CREAT |
 * O_EXCL`, so the write itself fails when `path` already exists instead of
 * silently replacing it, plus `O_NOFOLLOW` where the platform defines the
 * flag (every POSIX target Veduta ships on; `fs.constants.O_NOFOLLOW` is
 * `undefined` on Windows, so this degrades to plain `O_EXCL` there rather
 * than throwing on a missing constant) so a symlink swapped in for the
 * destination file cannot redirect the write either — the same
 * defence-in-depth `assertTemplateContainment` already applies to the
 * directory itself. `openSync` throws (`EEXIST`) rather than returning an
 * error code, so the caller's own try/catch (`applyTemplateImport`'s write
 * loop) sees a normal failure to react to.
 */
function writeTemplateFile(path: string, template: SurfaceTemplate, exclusive: boolean): void {
  const json = JSON.stringify(template, null, 2)
  if (!exclusive) {
    writeFileSync(path, json)
    return
  }
  const noFollowFlag = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollowFlag
  const fd = openSync(path, flags)
  try {
    // `writeFileSync` on the descriptor, not a bare `writeSync`: a single
    // `writeSync` can legally write fewer bytes than it was given, which
    // would leave a truncated Template on disk under a name the importer has
    // already claimed. `writeFileSync` loops until every byte lands.
    writeFileSync(fd, json)
  } finally {
    closeSync(fd)
  }
}

/**
 * Lowercase, non-`[a-z0-9]` runs collapsed to a single `-`, leading/trailing
 * `-` trimmed. Kept in lockstep with `SpaceSchema`'s `^[a-z0-9-]+$` slug
 * pattern (`@veduta/protocol`) so a name always slugifies to something the
 * schema accepts (a name with no letters or digits at all slugifies to `''`
 * — callers that mint a Space slug from user input, e.g.
 * `onboarding-step-first-space.ts`, must guard that case themselves rather
 * than letting it reach `SpaceSchema.parse` as an opaque ZodError).
 * Exported so every caller shares this one canonical rule instead of
 * keeping its own copy.
 */
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function uniqueSurfaceId(surfaceId: string, sourceSlug: string, usedIds: Set<string>): string {
  if (!usedIds.has(surfaceId)) return surfaceId
  const base = `${surfaceId}-from-${sourceSlug}`
  if (!usedIds.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`
    if (!usedIds.has(candidate)) return candidate
  }
}

/**
 * Total length a Template id may occupy on disk, per
 * `SurfaceTemplateIdSchema` (`^tpl-[a-z0-9][a-z0-9-]{0,63}$`): the literal
 * `tpl-` (4 chars) plus 1 required char plus up to 63 more.
 */
const TEMPLATE_ID_MAX_LENGTH = 68

/** The shortest string the schema still accepts: `tpl-` plus one character. */
const TEMPLATE_ID_MIN_LENGTH = 5

/**
 * Template-specific de-collision (issues/022-emergent-templates.md).
 * `uniqueSurfaceId`'s plain `${id}-from-<slug>` append can push a Surface id
 * arbitrarily long, but `SurfaceTemplateIdSchema` caps a Template id at
 * `TEMPLATE_ID_MAX_LENGTH` characters, so appending the same suffix
 * unconditionally could produce a candidate the schema then rejects. This
 * truncates the base id to leave room for the suffix, then re-validates the
 * candidate against the schema before it is ever used as a filename.
 *
 * `budget` is never clamped up to `TEMPLATE_ID_MIN_LENGTH`: an honest
 * `TEMPLATE_ID_MAX_LENGTH - suffix.length` that has already dropped below the
 * schema's minimum means no candidate at this suffix length can ever satisfy
 * the schema, so this throws rather than looping — a clamped budget used to
 * manufacture a candidate one character too long for
 * `SurfaceTemplateIdSchema`, which `safeParse` then rejected every time,
 * spinning the loop forever (reachable: a Space slug near the schema's
 * length ceiling, merged twice into a target that already holds both the
 * base id and the first de-collided one — see the matching test in
 * `spaces-engine.test.ts`).
 */
function uniqueTemplateId(templateId: string, sourceSlug: string, usedIds: Set<string>): string {
  if (!usedIds.has(templateId)) return templateId
  // Bounds the slug portion of the suffix itself: nothing caps a Space slug's
  // length, and without this an unusually long slug could shrink `budget`
  // below `TEMPLATE_ID_MIN_LENGTH` on the very first candidate.
  const slug = sourceSlug.slice(
    0,
    TEMPLATE_ID_MAX_LENGTH - TEMPLATE_ID_MIN_LENGTH - '-from-'.length,
  )
  for (let index = 0; ; index += 1) {
    const suffix = index === 0 ? `-from-${slug}` : `-from-${slug}-${index}`
    const budget = TEMPLATE_ID_MAX_LENGTH - suffix.length
    if (budget < TEMPLATE_ID_MIN_LENGTH) {
      throw new Error(
        `cannot de-collide Template id "${templateId}" for Space "${sourceSlug}": every ` +
          `candidate suffix now leaves less than the schema's minimum id length ` +
          `(${TEMPLATE_ID_MIN_LENGTH}) to work with — this Space holds an unworkable number of ` +
          'prior collisions for this id; rename or remove one of the colliding Templates first.',
      )
    }
    const candidate = `${templateId.slice(0, budget)}${suffix}`
    if (!usedIds.has(candidate) && SurfaceTemplateIdSchema.safeParse(candidate).success) {
      return candidate
    }
  }
}

/**
 * Exported for the importer (issue 020):
 * `readTargetState` needs the literal default template text to detect
 * whether an existing `SOUL.md` is still untouched (safe to import into
 * without `--overwrite`) or was already customized by the user (a
 * conflict). Behaviour is unchanged — this is the same private helper
 * `ensureBaseLayout` always used, now also callable from outside.
 */
export function defaultSoul(): string {
  return `# SOUL

You are Veduta's single Agent. You switch context between Spaces; you do not become a different agent per Space.

${ABSTENTION_RULE}

${SPACE_GRANULARITY_RULE}

${TIMER_RULE}
`
}

function defaultInstructions(spaceName: string): string {
  return `# INSTRUCTIONS

This Space is for the ${spaceName} life area. Keep goals as Surfaces inside this Space instead of creating narrower Spaces.
`
}

function section(title: string, body: string): string {
  const trimmed = body.trim()
  const heading = `# ${title}`
  return trimmed.toLowerCase().startsWith(heading.toLowerCase())
    ? trimmed
    : `${heading}\n\n${trimmed}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readOrEmpty(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function writeIfMissing(path: string, content: string): void {
  if (!existsSync(path)) writeFileSync(path, content)
}

function fileMtimeIso(path: string, fallback: string): string {
  try {
    return statSync(path).mtime.toISOString()
  } catch {
    return fallback
  }
}
