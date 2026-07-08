import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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
  emptyFactsDocument,
  formatFactsMarkdown,
  parseFactsMarkdown,
  searchFacts as searchFactsDocument,
  type CuratorOperation,
  type FactRecord,
  type FactsDocument,
} from './facts.ts'

export interface SpaceEvent {
  at: string
  spaceId: string
  type: string
  text: string
  origin: 'trusted:user' | 'trusted:system' | 'untrusted:external'
  payload?: JsonObject
}

export interface AppendSpaceEventInput {
  text: string
  type?: string
  at?: string
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

    this.mergeActiveFacts(target.id, this.readFacts(source.id).active)
    this.copySupersededFacts(target.id, this.readFacts(source.id).superseded)
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

  writeFact(spaceId: string, factText: string): WriteFactResult {
    const space = this.requireSpace(spaceId)
    const date = this.today()
    const result = curateFact(this.readFacts(space.id), factText, date)
    if (result.operation !== 'noop') {
      writeFileSync(this.factsPath(space), formatFactsMarkdown(result.document, date))
      this.appendEvent(space.id, {
        type: 'fact.write',
        text: `FACTS ${result.operation}: ${result.fact.text}`,
        origin: 'trusted:system',
      })
    }
    return {
      operation: result.operation,
      fact: result.fact,
      ...(result.previous === undefined ? {} : { previous: result.previous }),
    }
  }

  searchFacts(spaceId: string, query: string): FactRecord[] {
    this.requireSpace(spaceId)
    return searchFactsDocument(this.readFacts(spaceId), query)
  }

  appendEvent(spaceId: string, input: AppendSpaceEventInput): SpaceEvent {
    const space = this.requireSpace(spaceId)
    const at = input.at ?? this.nowIso()
    const event: SpaceEvent = {
      at,
      spaceId: space.id,
      type: input.type ?? 'turn',
      text: input.text,
      origin: input.origin ?? 'trusted:system',
      ...(input.payload === undefined ? {} : { payload: input.payload }),
    }
    appendFileSync(this.logPath(space, at), `${JSON.stringify(event)}\n`)
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
      section('FACTS', factsForContext(facts)),
      section('Recent Event log', eventsForContext(recentEvents)),
      section('INSTRUCTIONS', readOrEmpty(this.spacePath(space, INSTRUCTIONS_FILE))),
    ].join('\n\n')
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

  private copySupersededFacts(targetSpaceId: string, facts: FactRecord[]): void {
    if (facts.length === 0) return
    const target = this.requireSpace(targetSpaceId)
    const document = this.readFacts(target.id)
    const merged = { active: document.active, superseded: [...document.superseded, ...facts] }
    writeFileSync(this.factsPath(target), formatFactsMarkdown(merged, this.today()))
  }

  private mergeActiveFacts(targetSpaceId: string, facts: FactRecord[]): void {
    if (facts.length === 0) return
    const target = this.requireSpace(targetSpaceId)
    let document = this.readFacts(target.id)
    for (const fact of facts) {
      document = curateFact(document, fact.text, fact.noted ?? this.today()).document
    }
    writeFileSync(this.factsPath(target), formatFactsMarkdown(document, this.today()))
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

function slugify(input: string): string {
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

function defaultSoul(): string {
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

function factsForContext(facts: FactsDocument): string {
  const active =
    facts.active.length === 0
      ? ['No active facts noted.']
      : facts.active.map((fact) => `- ${fact.text} (noted: ${fact.noted ?? 'undated'})`)
  const superseded =
    facts.superseded.length === 0
      ? ['No superseded facts.']
      : facts.superseded.map((fact) => {
          const supersededAt = fact.supersededAt ? `; superseded: ${fact.supersededAt}` : ''
          return `- ${fact.text} (noted: ${fact.noted ?? 'undated'}${supersededAt})`
        })
  return [...active, '', 'Superseded:', ...superseded].join('\n')
}

function eventsForContext(events: SpaceEvent[]): string {
  if (events.length === 0) return 'No recent events.'
  return events.map((event) => `- ${event.at} [${event.type}] ${event.text}`).join('\n')
}

function section(title: string, body: string): string {
  const trimmed = body.trim()
  const heading = `# ${title}`
  return trimmed.toLowerCase().startsWith(heading.toLowerCase())
    ? trimmed
    : `${heading}\n\n${trimmed}`
}

function readEventsFile(path: string): SpaceEvent[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [parseSpaceEvent(JSON.parse(line))]
      } catch {
        return []
      }
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
  if (origin !== 'trusted:user' && origin !== 'trusted:system' && origin !== 'untrusted:external') {
    throw new Error('invalid Event log origin')
  }
  const payload = isJsonObject(input['payload']) ? input['payload'] : undefined
  return {
    at,
    spaceId,
    type,
    text,
    origin,
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
