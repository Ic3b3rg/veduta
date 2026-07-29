import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SpaceSchema,
  SurfaceSchema,
  type JsonObject,
  type JsonValue,
  type Space,
  type Surface,
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
  isUntrusted,
  isValidOrigin,
  untrustedDataBlock,
  untrustedSource,
  type Origin,
} from './taint.ts'
import { normalizeIsoInstant } from './timezone.ts'

export interface SpaceEvent {
  at: string
  spaceId: string
  type: string
  text: string
  origin: Origin
  /**
   * When the underlying thing happened, as opposed to `at` (when it was
   * recorded): an imported email's send time, a Calendar event's start,
   * versus the moment the reader or fast path appended this line
   * (issues/021-advanced-memory.md). Always normalized to a single ISO
   * instant before persisting — see `normalizeIsoInstant` (`timezone.ts`).
   */
  occurredAt?: string
  payload?: JsonObject
}

export interface AppendSpaceEventInput {
  text: string
  type?: string
  at?: string
  occurredAt?: string
  origin?: SpaceEvent['origin']
  payload?: JsonObject
}

export interface SpaceProposal {
  id: string
  name: string
  slug: string
  reason: string
  createdAt: string
}

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
  private readonly proposals = new Map<string, SpaceProposal>()
  private nextProposalId = 1
  private readonly memoryWriteObservers = new Set<(notice: MemoryWriteNotice) => void>()

  constructor(options: SpacesEngineOptions = {}) {
    this.rootDir = options.rootDir ?? defaultDataDir()
    this.now = options.now ?? (() => new Date())
    this.ensureBaseLayout()
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
    const proposal = {
      id: `space-proposal-${this.nextProposalId}`,
      name: input.name.trim(),
      slug: this.uniqueSlug(slugify(input.name)),
      reason: input.reason.trim(),
      createdAt: this.nowIso(),
    }
    this.nextProposalId += 1
    this.proposals.set(proposal.id, proposal)
    return proposal
  }

  confirmSpaceProposal(proposalId: string): Space {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) throw new Error(`unknown Space proposal: ${proposalId}`)
    this.proposals.delete(proposalId)
    const space = this.createSpace({ name: proposal.name, slug: proposal.slug })
    this.appendEvent(space.id, {
      type: 'lifecycle',
      text: `Confirmed Space proposal "${proposal.name}": ${proposal.reason}`,
      origin: 'trusted:user',
    })
    return space
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

  private initializeSpace(space: Space, instructions?: string): void {
    const parsed = SpaceSchema.parse(space)
    mkdirSync(this.spacePath(parsed), { recursive: true })
    mkdirSync(this.spacePath(parsed, 'log'), { recursive: true })
    mkdirSync(this.spacePath(parsed, 'surfaces'), { recursive: true })
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
    const existing = new Set(this.listAllSpaces().map((space) => space.slug))
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

function readerSummaryBlock(event: SpaceEvent): string | undefined {
  if (event.type !== 'reader.summary') return undefined
  const reader = event.payload?.['reader']
  if (!isJsonObject(reader)) return undefined
  // The source comes from the event's own origin mark — authoritative and
  // grammar-validated — never from a (forgeable) payload field.
  const source = untrustedSource(event.origin) ?? 'external'
  const fields = Object.entries(reader).map(
    ([key, value]) => [key, formatReaderFieldValue(value)] as [string, string],
  )
  return untrustedDataBlock(source, fields)
}

function formatReaderFieldValue(value: JsonValue): string {
  if (Array.isArray(value)) return value.map((item) => formatReaderFieldValue(item)).join(', ')
  if (value === null) return ''
  return String(value)
}

/**
 * Cap on a rendered event's `type` label (docs/SECURITY.md §3.2): `type` is
 * free-form text an `append_event` tool call chooses (`memory-tools.ts`'s
 * `AppendEventSchema` only requires it non-empty), so under an untrusted
 * turn it is exactly as attacker-controlled as `event.text` — but unlike
 * `event.text`, it renders on the header line outside `untrustedDataBlock`,
 * for every event regardless of origin. Left unbounded, it could otherwise
 * bloat context or carry `<<<END data>>>`/`<<<UNTRUSTED ...>>>` sequences
 * that counterfeit the delimiter grammar around it.
 */
const MAX_RENDERED_EVENT_TYPE_CHARS = 100

/**
 * Renders `event.type` for the header line `renderEventForContext` builds.
 *
 * An event type is a machine-chosen identifier — `turn`, `reader.summary`,
 * `fact.write`, `automation.fire` — so the renderer keeps only what such an
 * identifier is made of and collapses every other run to a single `-`. That
 * is deliberately stricter than neutralizing the delimiter tokens: a type is
 * the one attacker-reachable field that renders *outside*
 * `untrustedDataBlock`, on the header line, for every event regardless of
 * origin, so it must not be able to carry prose there at all — neither a
 * counterfeit `<<<END data>>>` nor a sentence addressed to the Agent. A colon
 * is excluded on purpose along with everything else: `system:` / `assistant:`
 * is the role-marker shape the quarantined reader's own tripwire rejects
 * (`REJECT_PATTERNS`, `quarantined-reader.ts`), and no real event type needs
 * one.
 * Newlines go first, since a multi-line type could otherwise fabricate whole
 * extra lines ahead of the real untrusted block.
 *
 * Writes are constrained at the schema too (`memory-tools.ts` rejects a
 * malformed or daemon-reserved type), and that is the primary defence. This
 * one exists because the Event log is append-only and never rewritten
 * (ADR-0003): a line already on disk from before that constraint — or from an
 * importer — can only be defended against at render time.
 */
function renderEventType(type: string): string {
  const identifier = type.replace(/\r?\n/g, ' ').replace(/[^A-Za-z0-9._-]+/g, '-')
  return identifier.slice(0, MAX_RENDERED_EVENT_TYPE_CHARS)
}

/**
 * The one taint-aware rendering of an Event log entry for anything the
 * Agent reads (`assembleContext`, the `read_recent`/`search_log` tool
 * results): untrusted event text renders only inside a delimited block —
 * the reader's own notices are content-free by construction, but a tainted
 * turn's `append_event` writes arbitrary text and must not reach the Agent
 * outside the delimiters.
 *
 * `event.type` is neutralized and capped (`renderEventType`) before it goes
 * on the header line, for both branches below: unlike `event.at`
 * (server-generated, never caller input — `appendEvent` defaults it and no
 * tool exposes it) and `event.occurredAt` (always run through
 * `normalizeIsoInstant` before being stored, so it can only ever be a valid
 * ISO instant), `type` reaches this renderer as arbitrary caller text and is
 * the one field here an untrusted turn actually controls.
 */
export function renderEventForContext(event: SpaceEvent): string {
  // Absent for the vast majority of events (anything the fast path or the
  // Agent itself appends, where recorded time IS occurred time), so the
  // suffix is empty and every rendering predating `occurredAt` is unchanged.
  const occurred = event.occurredAt === undefined ? '' : ` (occurred ${event.occurredAt})`
  const type = renderEventType(event.type)
  if (!isUntrusted(event.origin)) {
    return `- ${event.at}${occurred} [${type}] [${event.origin}] ${event.text}`
  }
  const line = `- ${event.at}${occurred} [${type}] [${event.origin}]`
  const source = untrustedSource(event.origin) ?? 'external'
  const block = readerSummaryBlock(event) ?? untrustedDataBlock(source, [['text', event.text]])
  return `${line}\n${block}`
}

function eventsForContext(events: SpaceEvent[]): string {
  if (events.length === 0) return 'No recent events.'
  return events.map(renderEventForContext).join('\n')
}

function section(title: string, body: string): string {
  const trimmed = body.trim()
  const heading = `# ${title}`
  return trimmed.toLowerCase().startsWith(heading.toLowerCase())
    ? trimmed
    : `${heading}\n\n${trimmed}`
}

/**
 * The one way to turn a raw Event log line back into a `SpaceEvent`:
 * `undefined` for a blank line, malformed JSON, or an entry missing a
 * required field. Exported because the memory index
 * (issues/021-advanced-memory.md) dereferences a hit by re-reading the line
 * it points at, and it must reconstruct exactly the event the Agent would
 * see in context — a second parser of its own could accept a line this one
 * rejects, or normalize a field differently, and then a retrieved record
 * would silently disagree with the injected one.
 */
export function parseSpaceEventLine(raw: string): SpaceEvent | undefined {
  if (!raw.trim()) return undefined
  try {
    return parseSpaceEvent(JSON.parse(raw))
  } catch {
    return undefined
  }
}

/**
 * Splits a `.jsonl` log file's text into physical lines, dropping the
 * trailing empty string produced by a file ending in a newline — that
 * artifact is not a real physical line, and `readLogEntriesFrom` and
 * `readLogLine` must agree on the same line count and the same line-N text,
 * or a memory-index reference minted by one would read back wrong through
 * the other (issues/021-advanced-memory.md).
 */
function splitLogLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function readEventsFile(path: string): SpaceEvent[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .flatMap((line) => {
      const event = parseSpaceEventLine(line)
      return event ? [event] : []
    })
}

function parseSpaceEvent(input: unknown): SpaceEvent {
  if (!isRecord(input)) throw new Error('invalid Event log entry')
  const at = stringValue(input['at'])
  const spaceId = stringValue(input['spaceId'])
  const type = stringValue(input['type'])
  const text = stringValue(input['text'])
  const origin = input['origin']
  if (!at || !spaceId || !type || !text) throw new Error('invalid Event log entry')
  if (!isValidOrigin(origin)) {
    throw new Error('invalid Event log origin')
  }
  const payload = isJsonObject(input['payload']) ? input['payload'] : undefined
  // Dropped, not thrown, when unparseable: the Event log is append-only and
  // never rewritten (ADR-0003), so a malformed `occurredAt` on one line —
  // e.g. hand-edited or produced by an older writer — must not make an
  // otherwise-readable line disappear from the whole file.
  const occurredAt = normalizeIsoInstant(stringValue(input['occurredAt']))
  return {
    at,
    spaceId,
    type,
    text,
    origin,
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(payload === undefined ? {} : { payload }),
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  if (!isRecord(value) || Array.isArray(value)) return false
  return Object.values(value).every(isJsonValue)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true
  }
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isJsonObject(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
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
