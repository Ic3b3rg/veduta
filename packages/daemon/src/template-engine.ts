import { z } from 'zod'
import {
  AtomNodeSchema,
  JsonObjectSchema,
  SYSTEM_SPACE_ID,
  SurfaceTemplateIdSchema,
  type ChatTurnCorrelation,
  type JsonObject,
  type SurfaceOrder,
  type Surface,
  type SurfaceTemplate,
} from '@veduta/protocol'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { Store } from './store.ts'
import {
  matchTemplates,
  normalizedIntent,
  surfaceFromTemplate,
  templateFromSurface,
  treeHash,
  treeSignature,
  type TemplateMatch,
  type TemplateMatchCandidate,
} from './templates.ts'
import {
  effectiveToolWriteOrigin,
  effectiveOrigin,
  isUntrusted,
  isValidOrigin,
  neutralizeDelimiters,
  toolWriteOrigin,
  untrustedDataBlock,
  untrustedOrigin,
  untrustedSource,
  type Origin,
} from './taint.ts'

/**
 * `TemplateEngine`: harvests stable Surfaces into Templates, lets the user
 * lock one in by pinning, matches a candidate composition against what
 * already exists, and instantiates a Template into a new Surface
 * (issues/022-emergent-templates.md; docs/adr/0003-declarative-atoms.md:
 * "good compositions get saved and reused"). Every Template save and reuse
 * appends its own Space Event log entry — the Agent must be able to find a
 * Template's origin before reasoning about the Space it lives in.
 */

/**
 * Default number of days a Surface's tree must go untouched before harvest
 * treats it as stable enough to become a Template. Long enough that a
 * composition still being iterated on is never captured while it is still
 * being reshaped, short enough that a genuinely settled Surface does not sit
 * un-reusable for weeks.
 */
export const STABILITY_DAYS = 7

/** A bounded, non-empty justification, trimmed before the length check. */
export const JUSTIFICATION_MAX_CHARS = 500

/**
 * Cap on the interpolated Template name / Surface title in a `template.saved`
 * or `template.reused` event's text, mirroring `SurfaceEngine.setPinned`'s own
 * `PIN_EVENT_TITLE_MAX_CHARS` cap on the pin event's title: both interpolate
 * attacker-reachable strings (an imported Template's `name`, a Surface's
 * `title`) into event text a later turn reads back, so both bound it the
 * same way.
 */
export const TEMPLATE_EVENT_TEXT_MAX_CHARS = 200

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Neutralizes and truncates text interpolated into a Template bookkeeping event. */
function safeEventText(value: string): string {
  return truncate(neutralizeDelimiters(value), TEMPLATE_EVENT_TEXT_MAX_CHARS)
}

export interface TemplateEngineOptions {
  store: Store
  now?: () => Date
  stabilityDays?: number
}

export interface PinResult {
  surface: Surface
  changed: boolean
  order: SurfaceOrder
  template?: SurfaceTemplate
}

export interface InstantiateTemplateInput {
  templateId: string
  templateSpaceId: string
  spaceId: string
  surfaceId: string
  title?: string
  state?: JsonObject
  /** The turn's origin, so an imported Template's untrusted mark cannot be laundered clean. */
  origin: Origin
  /** Live PWA chat correlation, omitted for every background creation path. */
  initiatingTurn?: ChatTurnCorrelation
}

/** A `matchTemplates` hit with the id of the Space the Template lives in. */
export interface TemplateEngineMatch extends TemplateMatch {
  spaceId: string
}

export class TemplateEngine {
  /**
   * Public like `Store.spacesEngine`: the tool wrappers in this module and
   * `gateCreateSurfaceTool` need direct access to Space Event log writes and
   * Template persistence, and forwarding every one of those through a
   * private field would just add indirection with no encapsulation gained
   * (`Store` itself is the single write path underneath).
   */
  readonly store: Store
  private readonly now: () => Date
  private readonly stabilityDays: number

  constructor(options: TemplateEngineOptions) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
    this.stabilityDays = options.stabilityDays ?? STABILITY_DAYS
  }

  /**
   * Templates every active Space's stable, non-daemon-owned Surfaces
   * (`Store.stableSurfaces`, which already excludes daemon-owned and
   * archived rows at the query level). Idempotent: a Surface already
   * templated at the same tree shape is skipped, so calling this on every
   * Template-reading path (list, match, instantiate) never duplicates work.
   * Returns only the Templates newly saved by this call.
   *
   * Reads each Space's existing Templates at most once for the whole call
   * (`harvestInto`'s cache), rather than once per stable Surface: a real
   * installation harvests on every gated `create_surface`, and re-reading
   * and re-hashing every Template file per Surface, per call, is thousands
   * of synchronous file reads, zod parses and sha256 hashes on the
   * daemon's single thread for no benefit — the cache is scoped to this one
   * call, with no lifetime or invalidation to manage.
   */
  harvest(): SurfaceTemplate[] {
    return this.harvestInto(new Map())
  }

  /**
   * `harvest`'s body, taking the per-Space Template cache as a parameter so
   * `match` can reuse the same reads instead of harvesting twice.
   */
  private harvestInto(templatesBySpace: Map<string, SurfaceTemplate[]>): SurfaceTemplate[] {
    const cutoffIso = new Date(
      this.now().getTime() - this.stabilityDays * MILLISECONDS_PER_DAY,
    ).toISOString()
    const activeSpaceIds = new Set(this.store.listSpaces().map((space) => space.id))
    const saved: SurfaceTemplate[] = []

    for (const surface of this.store.stableSurfaces(cutoffIso)) {
      if (!activeSpaceIds.has(surface.spaceId)) continue
      // `pinnable === false` is the projected FACTS Surface's own honest
      // signal (spaces-engine.ts's `factsSurface`); `stableSurfaces` never
      // returns it anyway (it is not a persisted row), but a Surface that
      // ever declares itself unpinnable should never be captured as a
      // reusable composition regardless of how it reached this loop.
      if (surface.pinnable === false) continue
      try {
        const template = this.saveTemplateFromSurface(
          surface,
          surface.spaceId,
          'stability',
          templatesBySpace,
        )
        if (template) saved.push(template)
      } catch (error) {
        // One malformed or unreadable Surface must not take the whole
        // harvest down — every other Space's stable Surfaces still need
        // templating, and the caller (a gated `create_surface`, `harvest`,
        // or `list_templates`) has no per-Surface recourse of its own.
        console.error(`TemplateEngine.harvest: skipping Surface "${surface.id}"`, error)
      }
    }

    return saved
  }

  /**
   * Locks or unlocks a Surface's tree via `Store.setPinned`, threading
   * `options` through unchanged. Pinning also saves a Template for that
   * Surface (`savedBy: 'pin'`), idempotent by tree shape exactly like
   * `harvest`. System Space pinning remains only a presentation preference,
   * so its Gateway-owned composition is never saved as a Template. Unpinning
   * never saves one. `options.updatedBy` excludes `'job'`: a daemon-owned
   * Surface manager writing as `job` has no business pinning or unpinning a
   * Surface it does not own.
   */
  pin(
    surfaceId: string,
    pinned: boolean,
    options: { origin: Origin; updatedBy: 'user' | 'agent' },
  ): PinResult {
    const mutation = this.store.setPinnedWithOrder(surfaceId, pinned, options)
    const { surface, changed, order } = mutation
    if (!changed || !pinned) return { surface, changed, order }
    const template = this.saveTemplateFromSurface(surface, surface.spaceId, 'pin', new Map())
    return template === undefined
      ? { surface, changed, order }
      : { surface, changed, order, template }
  }

  /**
   * Harvests, then ranks `candidate` against `spaceId`'s own Templates
   * first, followed by every other active Space's Templates — never an LLM
   * call. Each match carries the id of the Space its Template lives in, so
   * a cross-Space hit can be reported and reused. Shares one per-call
   * Template cache with the harvest this triggers (`harvestInto`), so a
   * Space's Templates are read once per `match` call, not once per
   * candidate Space plus once again inside the harvest loop.
   */
  match(candidate: TemplateMatchCandidate, spaceId: string): TemplateEngineMatch[] {
    const templatesBySpace = new Map<string, SurfaceTemplate[]>()
    this.harvestInto(templatesBySpace)

    const ownMatches = matchTemplates(
      this.templatesForSpace(spaceId, templatesBySpace),
      candidate,
    ).map((match) => ({ ...match, spaceId }))
    const otherMatches = this.store
      .listSpaces()
      .filter((space) => space.id !== spaceId)
      .flatMap((space) =>
        matchTemplates(this.templatesForSpace(space.id, templatesBySpace), candidate).map(
          (match) => ({
            ...match,
            spaceId: space.id,
          }),
        ),
      )

    return [...ownMatches, ...otherMatches]
  }

  /** Reads `spaceId`'s Templates once per `templatesBySpace` cache, reusing a prior read. */
  private templatesForSpace(
    spaceId: string,
    templatesBySpace: Map<string, SurfaceTemplate[]>,
  ): SurfaceTemplate[] {
    const cached = templatesBySpace.get(spaceId)
    if (cached) return cached
    const templates = this.store.spacesEngine.listTemplates(spaceId)
    templatesBySpace.set(spaceId, templates)
    return templates
  }

  /**
   * Instantiates `templateId` (from `templateSpaceId`) into a fresh Surface
   * in `spaceId`. `contentOrigin` combines the Template's own provenance
   * origin with the turn's origin via `effectiveOrigin`, so an imported
   * Template's untrusted mark survives reuse instead of being laundered as
   * `trusted:user` (docs/SECURITY.md §3.2). The fallback is `'trusted:user'`,
   * not `'trusted:system'`: an ordinary trusted reuse of a trusted Template is
   * an honest user-facing composition, and `'trusted:system'` would flow into
   * `enqueueAgentAction`'s event origin for every Template-instantiated
   * Surface, which the scheduler's condition rule specifically distinguishes
   * from genuine user activity. Appends `template.reused` to the destination
   * Space's Event log, with its own origin `effectiveOrigin([contentOrigin],
   * writeOrigin)` — the Template's own (possibly untrusted) provenance wins
   * over the turn's write origin, so an imported Template's bookkeeping event
   * cannot be laundered trusted just because a trusted turn reused it — and
   * the interpolated Template name neutralized and truncated before it is
   * ever rendered back to the Agent (docs/SECURITY.md §3.2). The created
   * Surface's provenance records `templateSpaceId` alongside `templateId`
   *: a Template id is only unique within its own
   * Space, so `templateId` alone cannot say which Template a reused Surface
   * actually came from.
   */
  instantiate(input: InstantiateTemplateInput): Surface {
    const template = this.store.spacesEngine.getTemplate(input.templateSpaceId, input.templateId)
    if (!template) {
      throw new Error(`unknown Template "${input.templateId}" in Space "${input.templateSpaceId}"`)
    }

    const candidate = surfaceFromTemplate(template, {
      surfaceId: input.surfaceId,
      spaceId: input.spaceId,
      updatedAt: this.now().toISOString(),
      updatedBy: 'agent',
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.state === undefined ? {} : { state: input.state }),
    })

    const contentOrigin = effectiveOrigin(
      [templateOrigin(template.provenance.origin), input.origin],
      'trusted:user',
    )
    const writeOrigin = toolWriteOrigin(input.origin)
    const eventOrigin = effectiveOrigin([contentOrigin], writeOrigin)

    const surface = this.store.createSurface(candidate, 'agent', {
      templateId: template.id,
      templateSpaceId: input.templateSpaceId,
      contentOrigin,
      origin: writeOrigin,
      ...(input.initiatingTurn === undefined ? {} : { initiatingTurn: input.initiatingTurn }),
    })

    this.store.spacesEngine.appendEvent(input.spaceId, {
      type: 'template.reused',
      origin: eventOrigin,
      text: `Reused Template "${safeEventText(template.name)}" from Space "${input.templateSpaceId}"`,
      payload: { templateId: template.id, sourceSpaceId: input.templateSpaceId },
    })

    return surface
  }

  /**
   * Shared by `harvest` and `pin`: derives a Template from `surface`,
   * excluding the Gateway-owned System Space, and skips the save when one
   * already exists in `spaceId` at the same tree
   * shape *and* the same normalized intent (`treeHash` over the *reduced*
   * tree, paired with `normalizedIntent` over the Template's own `intent` —
   * the same two values `templateIdEntropy` folds together for the
   * Template's own id, so a title change alone cannot spawn a duplicate, but
   * two Surfaces that share a tree shape for a genuinely different purpose
   * — a medication tracker and an expense tracker built from the same
   * layout — still become two Templates), and otherwise persists it and
   * appends `template.saved`. The provenance origin combines the Surface's own
   * content origin with `'trusted:system'`: a Surface built from an
   * imported Template cannot be re-derived as trusted (docs/SECURITY.md
   * §3.2). `template.saved` carries that same taint-aware `origin`, not a
   * hardcoded `'trusted:system'`, and its interpolated Template name and
   * Surface title are neutralized and truncated before they reach the
   * Event log an untrusted turn later reads back. `templatesBySpace` is
   * the caller's per-call cache (`harvestInto`/`pin`): read once via
   * `templatesForSpace` and updated here on save, so a harvest looping
   * over many Surfaces in the same Space never re-reads that Space's
   * Templates from disk.
   */
  private saveTemplateFromSurface(
    surface: Surface,
    spaceId: string,
    savedBy: 'pin' | 'stability',
    templatesBySpace: Map<string, SurfaceTemplate[]>,
  ): SurfaceTemplate | undefined {
    if (surface.spaceId === SYSTEM_SPACE_ID) return undefined
    const provenance = this.store.surfaceProvenance(surface.id)
    const contentOrigin = provenance?.contentOrigin ?? 'trusted:user'
    const origin = effectiveOrigin([contentOrigin], 'trusted:system')

    const candidate = templateFromSurface(surface, {
      savedBy,
      savedAt: this.now().toISOString(),
      origin,
    })

    const existing = this.templatesForSpace(spaceId, templatesBySpace)
    const candidateHash = treeHash(candidate.tree)
    const candidateIntent = normalizedIntent(candidate.intent)
    const isDuplicate = existing.some(
      (template) =>
        treeHash(template.tree) === candidateHash &&
        normalizedIntent(template.intent) === candidateIntent,
    )
    if (isDuplicate) return undefined

    const saved = this.store.spacesEngine.saveTemplate(spaceId, candidate)
    templatesBySpace.set(spaceId, [...existing, saved])
    this.store.spacesEngine.appendEvent(spaceId, {
      type: 'template.saved',
      origin,
      text: `Saved Template "${safeEventText(saved.name)}" from Surface "${safeEventText(surface.title)}"`,
      payload: { templateId: saved.id, surfaceId: surface.id },
    })

    return saved
  }
}

export interface TemplateToolOptions {
  activeSpaceId?: string
}

interface TemplateListEntry {
  template: SurfaceTemplate
  spaceId: string
  score?: number
}

const SpaceScopedSchema = z.object({
  spaceId: z.string().min(1).optional(),
})

const ListTemplatesSchema = SpaceScopedSchema.extend({
  intent: z.string().trim().min(1).optional(),
})

const CreateSurfaceFromTemplateSchema = SpaceScopedSchema.extend({
  templateId: SurfaceTemplateIdSchema,
  templateSpaceId: z.string().min(1).optional(),
  surfaceId: z.string().min(1),
  title: z.string().min(1).optional(),
  state: JsonObjectSchema.optional(),
})

/**
 * `pinned` is `z.literal(true)`, not `z.boolean()`: the Agent may capture a
 * composition by pinning, but unpinning is a human act, reachable only
 * through `POST /api/surfaces/:surfaceId/pin` (docs/adr/0012-emergent-templates.md).
 * Without this, the same `L0` tool that pins a Surface could also unpin it
 * and then patch its tree freely — `SurfaceEngine.patchTree`'s pin guarantee
 * only holds if the actor that can lift a pin is never the same actor the
 * pin exists to constrain.
 */
const PinSurfaceSchema = z.object({
  surfaceId: z.string().min(1),
  pinned: z.literal(true),
})

/**
 * Optional fields `gateCreateSurfaceTool` adds to whatever `create_surface`
 * schema it wraps: `intent` (defaults to the proposed title when absent)
 * and a bounded `justification` for regenerating instead of reusing a
 * matching Template.
 */
export const CreateSurfaceGateExtensionSchema = z.object({
  intent: z.string().trim().min(1).optional(),
  justification: z.string().trim().min(1).max(JUSTIFICATION_MAX_CHARS).optional(),
})

/**
 * The four `create_surface` fields `gateCreateSurfaceTool` reads directly
 * off the wrapped tool's input (`id`, `spaceId`, `title`, `tree`), declared
 * locally so the gate does not depend on the wrapped `ToolDef`'s own schema
 * type for them. `gateCreateSurfaceTool` accepts a plain `ToolDef`, whose
 * `schema` is typed as the generic `z.ZodTypeAny` — intersecting that with
 * this schema still validates all four fields at runtime (zod does not care
 * how TypeScript widens the type), but a TypeScript intersection absorbs an
 * `any` operand, so `z.infer` of that runtime schema collapses to `any`.
 * `CreateSurfaceGateInput` below, derived only from this schema and
 * `CreateSurfaceGateExtensionSchema` (neither of them `any`), is what
 * recovers compile-time checking: a rename of `title`/`tree`/`spaceId`/`id`
 * on `create_surface` itself now fails to compile here, instead of
 * producing `treeSignature(undefined)` at runtime.
 */
const CreateSurfaceGateInputSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  tree: AtomNodeSchema,
})

type CreateSurfaceGateInput = z.infer<typeof CreateSurfaceGateInputSchema> &
  z.infer<typeof CreateSurfaceGateExtensionSchema>

/**
 * The three Template-reuse tools (issues/022-emergent-templates.md):
 * `list_templates`, `create_surface_from_template`, `pin_surface`. The
 * justification gate on `create_surface` itself ships separately as
 * `gateCreateSurfaceTool`, since it wraps the Surface-creation tool
 * `Store.surfaceTools()` already exports rather than living inside this
 * factory. Every tool is `L0`/`egressDomains: []` (daemon-internal), and
 * every read reports `ToolResult.origins` so a turn that touches an
 * untrusted Template is tainted for whatever it does next
 * (docs/SECURITY.md §3.2).
 */
export function templateTools(
  engine: TemplateEngine,
  options: TemplateToolOptions = {},
): ToolDef[] {
  return [
    defineTool({
      name: 'list_templates',
      description:
        'List the active Space Templates, or the Templates matching an intent, across this Space and others.',
      schema: ListTemplatesSchema,
      level: 'L0',
      egressDomains: [],
      handler(input) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        // `engine.match` already harvests internally (`harvestInto`) — an
        // intent-filtered call must not harvest a second time here, on top
        // of the one `match` is about to do.
        let entries: TemplateListEntry[]
        if (input.intent === undefined) {
          engine.harvest()
          entries = engine.store.spacesEngine
            .listTemplates(spaceId)
            .map((template) => ({ template, spaceId }))
        } else {
          entries = engine.match({ intent: input.intent }, spaceId)
        }
        return {
          content: formatTemplateEntries(entries),
          details: { templates: entries },
          origins: entries.map((entry) => templateOrigin(entry.template.provenance.origin)),
        }
      },
    }),
    defineTool({
      name: 'create_surface_from_template',
      description: "Instantiate a Template into a new Surface, patching in this Space's own data.",
      schema: CreateSurfaceFromTemplateSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        const spaceId = resolveSpaceId(input.spaceId, options.activeSpaceId)
        const templateSpaceId = input.templateSpaceId ?? spaceId
        const origin = effectiveToolWriteOrigin(context.taint.origins(), context.origin)
        const surface = engine.instantiate({
          templateId: input.templateId,
          templateSpaceId,
          spaceId,
          surfaceId: input.surfaceId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.state === undefined ? {} : { state: input.state }),
          origin,
          ...(context.initiatingTurn === undefined
            ? {}
            : { initiatingTurn: context.initiatingTurn }),
        })
        const contentOrigin = engine.store.surfaceProvenance(surface.id)?.contentOrigin ?? origin
        return {
          content: `created Surface ${surface.id} from Template "${input.templateId}" (Space ${templateSpaceId})`,
          details: { surface },
          origins: [contentOrigin],
        }
      },
    }),
    defineTool({
      name: 'pin_surface',
      description:
        "Lock a Surface's tree, saving it as a Template. Unpinning is a human act and is not " +
        'available through this tool: the user unlocks a Surface from its own pin control.',
      schema: PinSurfaceSchema,
      level: 'L0',
      egressDomains: [],
      handler(input, context) {
        if (options.activeSpaceId !== undefined) {
          engine.store.readAuthorableSurface(options.activeSpaceId, input.surfaceId)
        }
        const { surface, template } = engine.pin(input.surfaceId, input.pinned, {
          origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
          updatedBy: 'agent',
        })
        const origins =
          template === undefined
            ? []
            : [
                engine.store.surfaceProvenance(surface.id)?.contentOrigin ??
                  templateOrigin(template.provenance.origin),
              ]
        return {
          content: `pinned Surface ${surface.id}${template === undefined ? '' : ` and saved Template ${template.id}`}`,
          details: { surface, template },
          origins,
        }
      },
    }),
  ]
}

/**
 * Wraps the engine's own `create_surface` tool (`Store.surfaceTools()`)
 * with the justification gate (issues/022-emergent-templates.md): when the
 * proposed intent and tree signature match an existing Template above
 * threshold and no `justification` is supplied, the create is refused and
 * the message names the matching Template, its Space, and the two ways
 * forward. A supplied `justification` lets the create proceed and appends
 * `template.regenerated`. No match at all delegates unchanged. The wrapped
 * tool stays the single Surface-creation write path — this function only
 * adds the refusal/regenerated bookkeeping around it.
 */
export function gateCreateSurfaceTool(tool: ToolDef, engine: TemplateEngine): ToolDef {
  const schema = tool.schema.and(CreateSurfaceGateInputSchema).and(CreateSurfaceGateExtensionSchema)

  return defineTool({
    name: tool.name,
    description: tool.description,
    schema,
    level: tool.level,
    egressDomains: tool.egressDomains,
    async handler(input: CreateSurfaceGateInput, context) {
      const candidateIntent: string = input.intent ?? input.title
      const candidateSignature = treeSignature(input.tree)
      const matches = engine.match(
        { intent: candidateIntent, signature: candidateSignature },
        input.spaceId,
      )
      const bestMatch = bestScoring(matches)

      if (bestMatch !== undefined && input.justification === undefined) {
        return {
          content:
            `A Template already matches this composition: "${bestMatch.template.id}" ` +
            `in Space "${bestMatch.spaceId}" (score ${bestMatch.score.toFixed(2)}). ` +
            `Reuse it with create_surface_from_template, or call create_surface again with a ` +
            `justification for why a fresh Surface is needed instead.`,
          origins: [templateOrigin(bestMatch.template.provenance.origin)],
        }
      }

      const result = await tool.handler(input, context)

      if (bestMatch !== undefined && input.justification !== undefined) {
        engine.store.spacesEngine.appendEvent(input.spaceId, {
          type: 'template.regenerated',
          origin: effectiveToolWriteOrigin(context.taint.origins(), context.origin),
          text: `Regenerated a Surface instead of reusing Template "${bestMatch.template.id}": ${input.justification}`,
          payload: {
            templateId: bestMatch.template.id,
            surfaceId: input.id,
            justification: input.justification,
          },
        })
      }

      return result
    },
  })
}

function bestScoring<T extends { score: number }>(matches: T[]): T | undefined {
  return matches.reduce<T | undefined>(
    (best, match) => (best === undefined || match.score > best.score ? match : best),
    undefined,
  )
}

/**
 * Every other read path in this daemon wraps untrusted strings in
 * `untrustedDataBlock` before they reach the Agent (docs/SECURITY.md §3.2);
 * `list_templates`'s own `content` must too. `name`, `intent`, `signature`
 * and `dataProps` all come straight from the Template's persisted bundle,
 * which for an imported Template is attacker-reachable text, up to
 * thousands of characters. A trusted entry keeps the plain, dense rendering
 * (cheap to scan across many Templates); an untrusted one renders inside
 * the delimited block instead, spotlighting note and all, so the Agent
 * cannot mistake an imported Template's fields for instructions.
 */
function formatTemplateEntries(entries: TemplateListEntry[]): string {
  if (entries.length === 0) return 'No Templates found.'
  return entries.map(formatTemplateEntry).join('\n')
}

function formatTemplateEntry(entry: TemplateListEntry): string {
  const scoreSuffix = entry.score === undefined ? '' : ` score=${entry.score.toFixed(2)}`
  const header = `${entry.template.id} (Space ${entry.spaceId})${scoreSuffix}`
  const origin = templateOrigin(entry.template.provenance.origin)

  if (isUntrusted(origin)) {
    const fields: [string, string][] = [
      ['name', entry.template.name],
      ['intent', entry.template.intent],
      ['signature', treeSignature(entry.template.tree)],
      ['dataProps', entry.template.dataProps.join(', ')],
    ]
    return `${header}\n${untrustedDataBlock(untrustedSource(origin) ?? 'unknown', fields)}`
  }

  return (
    `${header} — "${entry.template.name}" ` +
    `intent="${entry.template.intent}" signature="${treeSignature(entry.template.tree)}" ` +
    `dataProps=[${entry.template.dataProps.join(', ')}]`
  )
}

function resolveSpaceId(
  inputSpaceId: string | undefined,
  activeSpaceId: string | undefined,
): string {
  const spaceId = inputSpaceId ?? activeSpaceId
  if (!spaceId) throw new Error('active Space is required for this Template tool')
  return spaceId
}

/**
 * `SurfaceTemplateSchema`'s `provenance.origin` is validated against the
 * same grammar as `Origin` (`packages/protocol/src/template.ts`) but typed
 * as a plain `string` — the protocol package has no dependency on the
 * daemon's taint vocabulary. Narrows it back to `Origin` for callers that
 * feed it into `effectiveOrigin`/`ToolResult.origins`. Fails **closed** for
 * a value that does not parse as a valid `Origin`: this field is
 * security-relevant (it is what every Template bookkeeping event's origin
 * and every reuse's `contentOrigin` derive from), so a stored value
 * corrupted, hand-edited, or from a Template format this daemon does not
 * recognize must be treated as untrusted, never defaulted to
 * `'trusted:user'` (docs/SECURITY.md §3.2's fail-closed rule).
 */
function templateOrigin(value: string): Origin {
  return isValidOrigin(value) ? value : untrustedOrigin('unknown')
}
