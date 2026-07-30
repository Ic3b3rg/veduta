import { createHash } from 'node:crypto'
import {
  SurfaceSchema,
  SurfaceTemplateSchema,
  collectNodeBindingRefs,
  type Action,
  type AtomNode,
  type JsonObject,
  type JsonValue,
  type Surface,
  type SurfaceTemplate,
} from '@veduta/protocol'
import { wordsIn } from './facts.ts'
import { slugify } from './spaces-engine.ts'
import { neutralizeDelimiters, untrustedOrigin, type Origin } from './taint.ts'

/**
 * Pure derive/instantiate/match/sanitize helpers for Templates
 * (issues/022-emergent-templates.md; docs/adr/0003-declarative-atoms.md:
 * "good compositions get saved and reused"). No I/O, no SQLite, no `fs` —
 * persistence, harvesting and tool wiring live above this module.
 */

/**
 * A prop string longer than this is instance content an Agent put in the
 * tree instead of state — a composition's own labels are short, so
 * `templateFromSurface` blanks it rather than carrying it into the Template.
 */
export const TEMPLATE_PROP_MAX_CHARS = 120

/**
 * Below this score `matchTemplates` drops a candidate: coincidental sharing
 * of a single common word (e.g. "list", "tracker") must not by itself count
 * as a reuse match. Roughly "a third of the tokens overlap".
 */
export const TEMPLATE_MATCH_THRESHOLD = 0.3

/**
 * Bonus added to the token-overlap score when the candidate's structural
 * signature equals the Template's. Capped well under `TEMPLATE_MATCH_THRESHOLD`
 * on its own (0.2 < 0.3) so a shared signature can tip a borderline textual
 * match over the line, or let an exact match cleanly outrank a partial one,
 * but can never manufacture a match out of unrelated intents.
 */
const TEMPLATE_SIGNATURE_BONUS = 0.2

/**
 * Import caps (issues/022-emergent-templates.md). `AtomNodeSchema` is
 * `z.lazy` recursive, so a deeply nested untrusted payload would blow the
 * call stack inside zod's own validation before any of these caps could
 * apply — `sanitizeImportedTemplate` therefore enforces them with an
 * iterative walk of the raw, unparsed JSON first.
 */
export const TEMPLATE_IMPORT_MAX_DEPTH = 32
/**
 * Caps the number of JSON values (objects, arrays, and scalars alike) the
 * iterative walk below visits — not the number of Atom nodes. An Atom node
 * with a handful of props and a couple of actions is several JSON values on
 * its own, so this is a coarse, conservative proxy for "how much tree", not
 * a literal node-count limit: an imported Template is refused well before
 * ~500 actual Atom nodes, typically in the low hundreds. Chosen deliberately
 * over "count only objects carrying a `type` key" (which would allow a
 * proportionally larger payload of the same nominal cap) because the coarser,
 * safer proxy costs nothing here — imports are small, human-curated bundles,
 * not a place worth spending complexity to squeeze out a higher headroom.
 */
export const TEMPLATE_IMPORT_MAX_JSON_VALUES = 500
export const TEMPLATE_IMPORT_MAX_STRING_LENGTH = 4000
export const TEMPLATE_IMPORT_MAX_LIST_LENGTH = 200

const TEMPLATE_ID_PREFIX = 'tpl-'
/** Matches `SurfaceTemplateIdSchema`'s `^tpl-[a-z0-9][a-z0-9-]{0,63}$`: up to 64 chars after the prefix. */
const TEMPLATE_ID_MAX_CORE_LENGTH = 64
const TEMPLATE_ID_HASH_LENGTH = 16

/**
 * Deterministic digest of the Atom-type multiset: sorted `type:count` pairs
 * joined by `|` (e.g. `Box:1|Progress:1|Stat:2|Title:1`). Stable regardless
 * of sibling order — the structural half of a Template match.
 */
export function treeSignature(tree: AtomNode): string {
  const counts = new Map<string, number>()
  walkAtomTree(tree, (node) => {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1)
  })

  return Array.from(counts.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([type, count]) => `${type}:${count}`)
    .join('|')
}

/**
 * Preorder traversal (root, then each child's subtree, left to right) of an
 * Atom tree: `visit` is called once per node. An explicit stack, never
 * recursion — so a very deep tree cannot blow the call stack — and children
 * are pushed one at a time in a loop, never via `stack.push(...node.children)`,
 * which throws `RangeError: Maximum call stack size exceeded` on a node wide
 * enough (spread turns into one argument per element). Shared by every
 * read-only walk of a tree already in hand (`treeSignature` here,
 * `collectPropLines` in `template-export.ts`). A walk that builds a new tree
 * instead of just visiting one (`reduceTreeProps`, the importer's sanitizer
 * below) keeps its own recursive function: forcing a transformation through
 * a `visit` callback reads worse than the two small recursive functions
 * already are.
 */
export function walkAtomTree(root: AtomNode, visit: (node: AtomNode) => void): void {
  const stack: AtomNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === undefined) break
    visit(node)
    const children = node.children
    if (children) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index]
        if (child !== undefined) stack.push(child)
      }
    }
  }
}

/**
 * Full hex sha256 of a canonical JSON serialization of the tree (keys
 * sorted, so key order never changes the hash). Used by callers for harvest
 * de-duplication (`template-engine.ts` compares this value alone, tree
 * against tree) and, folded together with `intent` via `templateIdEntropy`,
 * as part of the entropy source for a Template's id.
 */
export function treeHash(tree: AtomNode): string {
  return createHash('sha256').update(canonicalJson(tree)).digest('hex')
}

/**
 * Entropy source for `templateId`: sha256 of `intent` and the tree hash
 * together, not the tree hash alone. Two Templates with the same name and
 * the same tree but a different intent are reused for different purposes
 * and must not collide on one id — folding only the tree in let that happen
 * whenever `name` slugified to something non-empty (the common case), since
 * `templateId` then never looked at `intent` at all.
 */
function templateIdEntropy(intent: string, hash: string): string {
  // `hash` is always a fixed-length hex digest that never contains a
  // literal backslash-zero, so this join has no ambiguity between two
  // different (intent, hash) pairs.
  return createHash('sha256').update(`${intent}\0${hash}`).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    )
  }
  return value
}

export interface TemplateFromSurfaceOptions {
  savedBy: 'pin' | 'stability'
  savedAt: string
  origin: Origin
  name?: string
  intent?: string
}

/**
 * Derives a Template from a Surface: the tree without data. `stateKeys` is
 * every key the tree binds or a fast action targets (via
 * `collectNodeBindingRefs`, the same traversal `SurfaceSchema` uses); the
 * tree's props are reduced (`reduceTreeProps`) so no instance data — a long
 * label, a `Table.rows`-shaped collection — travels with the composition.
 * Never copies a value out of `surface.state`.
 */
export function templateFromSurface(
  surface: Surface,
  options: TemplateFromSurfaceOptions,
): SurfaceTemplate {
  const stateKeys = Array.from(
    new Set(collectNodeBindingRefs(surface.tree, ['tree']).map((ref) => ref.key)),
  ).sort()

  const dataProps: string[] = []
  const tree = reduceTreeProps(surface.tree, dataProps)

  const name = options.name ?? surface.title
  const intent = options.intent ?? surface.title
  const idEntropy = templateIdEntropy(intent, treeHash(tree))

  const candidate = {
    formatVersion: 1 as const,
    id: templateId(name, intent, idEntropy),
    name,
    intent,
    tree,
    stateKeys,
    dataProps: Array.from(new Set(dataProps)).sort(),
    provenance: {
      sourceSurfaceId: surface.id,
      sourceSpaceId: surface.spaceId,
      savedAt: options.savedAt,
      savedBy: options.savedBy,
      origin: options.origin,
    },
  }

  return SurfaceTemplateSchema.parse(candidate)
}

/**
 * `tpl-<slug>-<first 16 hex chars of idEntropy>`, truncated so the result
 * still satisfies `SurfaceTemplateIdSchema`'s grammar. Slugifies `name`
 * first (the Template's primary label), falling back to `intent`, then to
 * the literal `template` when both slugify to `''`. `idEntropy` (from
 * `templateIdEntropy`) already folds `intent` into the hash, so two
 * Templates with the same name and tree but a different intent still get
 * different ids even when the slug portion is identical.
 */
function templateId(name: string, intent: string, idEntropy: string): string {
  const hashPrefix = idEntropy.slice(0, TEMPLATE_ID_HASH_LENGTH)
  const maxSlugLength = TEMPLATE_ID_MAX_CORE_LENGTH - 1 - hashPrefix.length
  const rawSlug = slugify(name) || slugify(intent)
  const truncated = (rawSlug || 'template').slice(0, maxSlugLength).replace(/-+$/, '')
  const slug = truncated === '' ? 'template' : truncated
  return `${TEMPLATE_ID_PREFIX}${slug}-${hashPrefix}`
}

/**
 * Walks `node`, keeping `id`, `type`, `binding`, `actions` and `children`
 * exactly as they were, and reducing `props` per issues/022-emergent-templates.md:
 * a string longer than `TEMPLATE_PROP_MAX_CHARS` is blanked; an array or
 * object value is dropped and its `"<nodeId>.<propKey>"` recorded into
 * `dataProps`. Together these are what makes "the tree without data" true
 * for props, not just for state.
 */
function reduceTreeProps(node: AtomNode, dataProps: string[]): AtomNode {
  const props =
    node.props === undefined ? undefined : reduceNodeProps(node.id, node.props, dataProps)
  const children = node.children?.map((child) => reduceTreeProps(child, dataProps))

  return {
    id: node.id,
    type: node.type,
    ...(node.binding !== undefined ? { binding: node.binding } : {}),
    ...(node.actions !== undefined ? { actions: node.actions } : {}),
    ...(props !== undefined ? { props } : {}),
    ...(children !== undefined ? { children } : {}),
  }
}

function reduceNodeProps(nodeId: string, props: JsonObject, dataProps: string[]): JsonObject {
  const reduced: JsonObject = {}

  for (const [key, value] of Object.entries(props)) {
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      dataProps.push(`${nodeId}.${key}`)
      continue
    }
    if (typeof value === 'string' && value.length > TEMPLATE_PROP_MAX_CHARS) {
      reduced[key] = ''
      continue
    }
    reduced[key] = value
  }

  return reduced
}

export interface SurfaceFromTemplateOptions {
  surfaceId: string
  spaceId: string
  title?: string
  state?: JsonObject
  pinned?: boolean
  updatedAt: string
  updatedBy: 'agent' | 'user' | 'job'
}

/**
 * Instantiates a Surface from a Template: the tree verbatim, state seeded
 * with the supplied values plus `null` for every declared `stateKey` the
 * caller did not provide (so `SurfaceSchema`'s binding validation passes).
 * Rejects a supplied state key absent from the Template's `stateKeys` — an
 * instantiation must not smuggle unbound data in. Clock-free: the caller
 * supplies `updatedAt`/`updatedBy`.
 */
export function surfaceFromTemplate(
  template: SurfaceTemplate,
  options: SurfaceFromTemplateOptions,
): Surface {
  const providedState = options.state ?? {}
  const stateKeySet = new Set(template.stateKeys)

  for (const key of Object.keys(providedState)) {
    if (!stateKeySet.has(key)) {
      throw new Error(`state key "${key}" is not declared in Template "${template.id}"'s stateKeys`)
    }
  }

  const state: JsonObject = {}
  for (const key of template.stateKeys) {
    state[key] = providedState[key] ?? null
  }

  const candidate = {
    id: options.surfaceId,
    spaceId: options.spaceId,
    title: options.title ?? template.name,
    tree: template.tree,
    state,
    freshness: { updatedAt: options.updatedAt, updatedBy: options.updatedBy },
    ...(options.pinned !== undefined ? { pinned: options.pinned } : {}),
  }

  return SurfaceSchema.parse(candidate)
}

export interface TemplateMatchCandidate {
  intent: string
  signature?: string
}

export interface TemplateMatch {
  template: SurfaceTemplate
  score: number
}

/**
 * Deterministic normalization of a free-text intent, for deduplicating a
 * harvest by tree *plus* intent rather than tree alone: two Surfaces with
 * the same composition but a genuinely different intent must still become
 * two separate Templates (`templateIdEntropy` above already makes this
 * distinction for a Template's id, by folding `intent` into its hash).
 * Reuses `wordsIn` — the same tokenizer `matchTemplates` builds its Jaccard
 * sets from, so this never drifts from what "the same intent" means there —
 * then deduplicates and sorts the words so two intents differing only in
 * word order or a repeated word normalize identically. Exported for
 * `template-engine.ts`'s harvest, so it reuses this rather than writing a
 * second normalizer that could disagree with `matchTemplates`'s own notion
 * of intent equality.
 */
export function normalizedIntent(intent: string): string {
  return Array.from(new Set(wordsIn(intent)))
    .sort()
    .join(' ')
}

/**
 * Ranks `templates` against `candidate` by token overlap over the
 * Template's `intent` + `name` (Jaccard-style, using `wordsIn` — no second
 * tokenizer), plus `TEMPLATE_SIGNATURE_BONUS` when `candidate.signature`
 * equals `treeSignature(template.tree)`. A Template never persists its own
 * signature (`packages/protocol/src/template.ts`: it is a pure function of
 * `tree`, so storing it would let an imported bundle forge a signature that
 * does not describe its own tree) — `candidate.signature` is the caller's
 * own proposed tree's signature, computed by the caller before this call,
 * never read off disk. Entries below `TEMPLATE_MATCH_THRESHOLD` are
 * dropped; a candidate intent that tokenizes to nothing (`wordsIn` returns
 * `[]`) always returns `[]`. Sorted by score desc, then `provenance.savedAt`
 * desc, then `id` asc.
 */
export function matchTemplates(
  templates: SurfaceTemplate[],
  candidate: TemplateMatchCandidate,
): TemplateMatch[] {
  const candidateTokens = new Set(wordsIn(candidate.intent))
  if (candidateTokens.size === 0) return []

  const matches: TemplateMatch[] = []
  for (const template of templates) {
    const templateTokens = new Set([...wordsIn(template.intent), ...wordsIn(template.name)])
    const overlap = jaccard(candidateTokens, templateTokens)
    const signatureBonus =
      candidate.signature !== undefined && candidate.signature === treeSignature(template.tree)
        ? TEMPLATE_SIGNATURE_BONUS
        : 0
    const score = Math.min(1, overlap + signatureBonus)

    if (score >= TEMPLATE_MATCH_THRESHOLD) {
      matches.push({ template, score })
    }
  }

  return matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    const savedAtA = a.template.provenance.savedAt
    const savedAtB = b.template.provenance.savedAt
    if (savedAtA !== savedAtB) return savedAtA < savedAtB ? 1 : -1
    if (a.template.id === b.template.id) return 0
    return a.template.id < b.template.id ? -1 : 1
  })
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Enforces the depth/node-count/string-length/list-length caps over the
 * raw, unparsed JSON with an explicit stack — never recursion, so a
 * hostile 5000-deep payload is refused in bounded memory instead of
 * overflowing the call stack before `SurfaceTemplateSchema` (whose `tree`
 * field is `z.lazy` recursive) ever gets to look at it.
 */
function enforceImportCaps(raw: unknown): void {
  const stack: { value: unknown; depth: number }[] = [{ value: raw, depth: 0 }]
  let nodeCount = 0

  while (stack.length > 0) {
    const item = stack.pop()
    if (item === undefined) break
    const { value, depth } = item

    nodeCount += 1
    if (nodeCount > TEMPLATE_IMPORT_MAX_JSON_VALUES) {
      throw new Error(
        `imported Template exceeds the max JSON value count (${TEMPLATE_IMPORT_MAX_JSON_VALUES})`,
      )
    }
    if (depth > TEMPLATE_IMPORT_MAX_DEPTH) {
      throw new Error(`imported Template exceeds the max depth (${TEMPLATE_IMPORT_MAX_DEPTH})`)
    }
    if (typeof value === 'string' && value.length > TEMPLATE_IMPORT_MAX_STRING_LENGTH) {
      throw new Error(
        `imported Template has a string longer than the max length (${TEMPLATE_IMPORT_MAX_STRING_LENGTH})`,
      )
    }

    if (Array.isArray(value)) {
      for (const element of value) stack.push({ value: element, depth: depth + 1 })
      continue
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        if (
          (key === 'stateKeys' || key === 'dataProps') &&
          Array.isArray(nested) &&
          nested.length > TEMPLATE_IMPORT_MAX_LIST_LENGTH
        ) {
          throw new Error(
            `imported Template's "${key}" exceeds the max list length (${TEMPLATE_IMPORT_MAX_LIST_LENGTH})`,
          )
        }
        stack.push({ value: nested, depth: depth + 1 })
      }
    }
  }
}

/** `sanitizeImportedTemplate`'s result: the cleaned Template plus how many `agent`-path actions it stripped. */
export interface SanitizedImportedTemplate {
  template: SurfaceTemplate
  /** Total `path: 'agent'` actions removed from `template.tree`, counted in the same walk that removes them. */
  strippedAgentActions: number
}

/**
 * The untrusted-input door for an imported Template
 * (issues/022-emergent-templates.md), in a fixed order: (1) the iterative
 * cap walk above, on the raw JSON; (2) schema parse; (3) `neutralizeDelimiters`
 * over every attacker-reachable string reachable from the parsed Template —
 * name, intent, node ids, bindings, action names, a fast action's `stateKey`,
 * every prop value *and* prop object key (`sanitizeProps`, applied
 * recursively so a nested object's keys are covered too), every string
 * inside an action `payload` (values and keys, same `sanitizeProps`),
 * `stateKeys`, `dataProps`, and the provenance source ids — `binding`
 * included, because `SurfaceTemplateSchema` cross-checks every binding (and
 * every fast action's `stateKey`) against the (also neutralized) `stateKeys`,
 * so leaving either un-neutralized would make a `<<<`-carrying one fail that
 * check with an opaque schema error instead of coming out clean; (4) every
 * `path: 'agent'` action stripped from the tree — an imported bundle
 * contributes layout, never behaviour — counted as it is stripped, in the
 * same walk, rather than by a second pass over the tree afterwards; (5)
 * `provenance.origin` rewritten to `untrustedOrigin(source)`; (6) re-parse.
 *
 * `signature` is deliberately absent from this list: `SurfaceTemplateSchema`
 * no longer has such a field (`packages/protocol/src/template.ts` —
 * `treeSignature(template.tree)` is computed wherever matching needs it, not
 * carried on the wire), so there is nothing left here to neutralize or
 * forge.
 */
export function sanitizeImportedTemplate(raw: unknown, source: string): SanitizedImportedTemplate {
  enforceImportCaps(raw)

  const parsed = SurfaceTemplateSchema.parse(raw)
  const { node: tree, strippedAgentActions } = sanitizeAndFilterNode(parsed.tree)

  const sanitized = {
    ...parsed,
    name: neutralizeDelimiters(parsed.name),
    intent: neutralizeDelimiters(parsed.intent),
    tree,
    stateKeys: parsed.stateKeys.map(neutralizeDelimiters),
    dataProps: parsed.dataProps.map(neutralizeDelimiters),
    provenance: {
      ...parsed.provenance,
      sourceSurfaceId: neutralizeDelimiters(parsed.provenance.sourceSurfaceId),
      sourceSpaceId: neutralizeDelimiters(parsed.provenance.sourceSpaceId),
      origin: untrustedOrigin(source),
    },
  }

  return { template: SurfaceTemplateSchema.parse(sanitized), strippedAgentActions }
}

interface SanitizedNode {
  node: AtomNode
  strippedAgentActions: number
}

function sanitizeAndFilterNode(node: AtomNode): SanitizedNode {
  let strippedAgentActions = 0
  const actions: Action[] | undefined = node.actions
    ?.filter((action) => {
      if (action.path !== 'agent') return true
      strippedAgentActions += 1
      return false
    })
    .map((action) => ({
      ...action,
      name: neutralizeDelimiters(action.name),
      ...(action.stateKey !== undefined ? { stateKey: neutralizeDelimiters(action.stateKey) } : {}),
      payload: sanitizeProps(action.payload),
    }))
  const props = node.props === undefined ? undefined : sanitizeProps(node.props)

  let children: AtomNode[] | undefined
  if (node.children) {
    children = []
    for (const child of node.children) {
      const sanitizedChild = sanitizeAndFilterNode(child)
      children.push(sanitizedChild.node)
      strippedAgentActions += sanitizedChild.strippedAgentActions
    }
  }

  return {
    node: {
      id: neutralizeDelimiters(node.id),
      type: node.type,
      ...(node.binding !== undefined ? { binding: neutralizeDelimiters(node.binding) } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(props !== undefined ? { props } : {}),
      ...(children !== undefined ? { children } : {}),
    },
    strippedAgentActions,
  }
}

/**
 * Neutralizes every string reachable from a JSON object one level down —
 * both its own keys and, recursively, every string nested inside its
 * values (`sanitizeJsonValue`). Shared by a node's `props` and a fast
 * action's `payload`: both are attacker-controlled `JsonObject`s an
 * imported Template can shape freely, and a key is exactly as forgeable as
 * a value (a `<<<`-carrying prop *name* renders inside the same untrusted
 * data block a `<<<`-carrying prop *value* would, docs/SECURITY.md §3.2).
 */
function sanitizeProps(props: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(props).map(([key, value]) => [
      neutralizeDelimiters(key),
      sanitizeJsonValue(value),
    ]),
  )
}

function sanitizeJsonValue(value: JsonValue): JsonValue {
  if (typeof value === 'string') return neutralizeDelimiters(value)
  if (Array.isArray(value)) return value.map(sanitizeJsonValue)
  if (value !== null && typeof value === 'object') return sanitizeProps(value)
  return value
}
