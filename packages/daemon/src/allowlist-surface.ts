import { SurfaceSchema, type AtomNode, type PatchOperation, type Surface } from '@veduta/protocol'
import type { FastMutationNotice, Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import type { AllowlistRule } from './trust-layer.ts'

/**
 * The trust admin "Allowlisted actions" Surface (issue #14, D8): every
 * active allowlist rule the user granted via an approval card's "from now
 * on approve like this" checkbox, with a per-rule Revoke action. Lives in
 * the (now persisted, `ensureSystemSpace`) System Space alongside the
 * usage and audit Surfaces. The tree shape is fixed — root Box ->
 * [Title, Caption, list Box] — so refreshes replace only the list node,
 * mirroring the Automations Surface (`automations-surface.ts`).
 */
export const ALLOWLIST_SURFACE_ID = 'srf-trust-allowlist'
export const ALLOWLIST_LIST_NODE_ID = 'trust-allowlist-list'

/** The state key a rule's Revoke button mutates on click (D2's per-rule fast action). */
export function revokeStateKey(ruleId: number): string {
  return `revoke.${ruleId}`
}

export function ruleIdFromRevokeStateKey(stateKey: string): number | undefined {
  const match = /^revoke\.(\d+)$/.exec(stateKey)
  return match ? Number(match[1]) : undefined
}

/**
 * The Surface's state object: one entry per rule's Revoke fast action
 * (protocol requires every fast action's `stateKey` to exist in `state`).
 * The value itself carries no meaning — the click is a one-shot trigger,
 * not a persisted toggle — so it always starts `false`.
 */
export function allowlistState(rules: AllowlistRule[]): Record<string, boolean> {
  return Object.fromEntries(rules.map((rule) => [revokeStateKey(rule.id), false]))
}

function formatParams(params: Record<string, string>): string {
  const entries = Object.entries(params)
  if (entries.length === 0) return 'no parameters'
  return entries.map(([key, value]) => `${key}=${value}`).join(', ')
}

export function allowlistListNode(rules: AllowlistRule[]): AtomNode {
  const children: AtomNode[] =
    rules.length === 0
      ? [
          {
            id: 'no-allowlist-rules',
            type: 'Caption',
            props: { text: 'No allowlisted actions yet.' },
          },
        ]
      : rules.map((rule) => ({
          id: `allowlist-rule-${rule.id}`,
          type: 'Row',
          children: [
            {
              id: `allowlist-rule-${rule.id}-summary`,
              type: 'ListItem',
              // `label`/`detail` are the props ListItemAtom (@veduta/catalog
              // atoms.tsx) actually reads — `title`/`subtitle` render nothing.
              props: {
                label: rule.toolName,
                detail: `${formatParams(rule.params)} — allowed since ${rule.createdAt}`,
              },
            },
            {
              id: `allowlist-rule-${rule.id}-revoke`,
              type: 'Button',
              props: { label: 'Revoke' },
              actions: [
                {
                  name: 'revoke',
                  path: 'fast',
                  payload: { value: true },
                  stateKey: revokeStateKey(rule.id),
                },
              ],
            },
          ],
        }))
  return { id: ALLOWLIST_LIST_NODE_ID, type: 'Box', children }
}

export function allowlistSurface(
  rules: AllowlistRule[],
  freshness: { updatedAt: string; updatedBy: 'job' },
): Surface {
  return SurfaceSchema.parse({
    id: ALLOWLIST_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Allowlisted actions',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Allowlisted actions' } },
        {
          id: 'subtitle',
          type: 'Caption',
          props: {
            text: 'Actions the Agent may run without asking again. Revoke to require approval next time.',
          },
        },
        allowlistListNode(rules),
      ],
    },
    state: allowlistState(rules),
    freshness,
  })
}

/**
 * The slice of `TrustLayer` this manager depends on (structural, not a
 * direct import of the concrete class beyond the `AllowlistRule` type):
 * keeps this module testable without standing up a full trust layer, and
 * a real `TrustLayer` instance satisfies it as-is.
 */
export interface AllowlistSource {
  listAllowlistRules(): AllowlistRule[]
  revokeAllowlistRule(id: number): void
  onChange(listener: () => void): () => void
}

export interface AllowlistSurfaceManagerOptions {
  store: Store
  trust: AllowlistSource
  now?: () => Date
}

/**
 * Projects the trust layer's allowlist onto `srf-trust-allowlist`,
 * following the scheduler's Surface-manager pattern
 * (`scheduler.ts`'s `ensureSurfaces`/`refreshSurface`): pre-create at
 * boot, rebuild on every trust-layer change, and turn a Revoke click
 * (observed via `store.onFastMutation`) into `trust.revokeAllowlistRule`.
 */
export class AllowlistSurfaceManager {
  private readonly store: Store
  private readonly trust: AllowlistSource
  private readonly now: () => Date
  private disposeChange: (() => void) | undefined
  private disposeFastMutation: (() => void) | undefined
  private dirty = false
  private coalesced: Promise<void> | undefined

  constructor(options: AllowlistSurfaceManagerOptions) {
    this.store = options.store
    this.trust = options.trust
    this.now = options.now ?? (() => new Date())
  }

  /** Pre-create the Surface (if missing) and start observing changes. */
  start(): void {
    this.ensureSurface()
    this.disposeChange = this.trust.onChange(() => this.scheduleRebuild())
    this.disposeFastMutation = this.store.onFastMutation((notice) =>
      this.handleFastMutation(notice),
    )
  }

  dispose(): void {
    this.disposeChange?.()
    this.disposeChange = undefined
    this.disposeFastMutation?.()
    this.disposeFastMutation = undefined
  }

  /** Test hook: resolves once any rebuild coalesced by the current burst has run. */
  flush(): Promise<void> {
    return this.coalesced ?? Promise.resolve()
  }

  private ensureSurface(): void {
    if (!this.store.getSurface(ALLOWLIST_SURFACE_ID)) this.refreshSurface()
  }

  /**
   * `trust.onChange` can fire 2-4x per user action (decision audit, decided
   * audit, allowlist.created, outcome) and each firing would otherwise
   * synchronously rebuild this Surface from scratch. Coalesce every firing
   * within the same microtask burst into a single rebuild (Fix 9b): a
   * `dirty` flag plus one shared, self-clearing microtask.
   */
  private scheduleRebuild(): void {
    this.dirty = true
    if (this.coalesced) return
    this.coalesced = Promise.resolve().then(() => {
      this.coalesced = undefined
      if (!this.dirty) return
      this.dirty = false
      this.refreshSurface()
    })
  }

  private handleFastMutation(notice: FastMutationNotice): void {
    if (notice.surfaceId !== ALLOWLIST_SURFACE_ID) return
    const ruleId = ruleIdFromRevokeStateKey(notice.stateKey)
    if (ruleId === undefined) return
    // The revoke click's own fast-path patch broadcasts synchronously as
    // this observer returns (surface-engine.ts's central subscription);
    // the rebuild that `trust.onChange` triggers below must reach clients
    // afterward, with a higher cursor — deferred to a microtask, same
    // reasoning as the scheduler's healing refresh (scheduler.ts).
    queueMicrotask(() => {
      try {
        this.trust.revokeAllowlistRule(ruleId)
      } catch (error) {
        console.error('allowlist-surface: revoke failed', error)
      }
    })
  }

  /** Project the trust layer's active rules (the source of truth) onto the Surface. */
  private refreshSurface(): void {
    const rules = this.trust.listAllowlistRules().filter((rule) => rule.revokedAt === undefined)
    const freshness = { updatedAt: this.now().toISOString(), updatedBy: 'job' as const }
    const existing = this.store.getSurface(ALLOWLIST_SURFACE_ID)

    if (!existing) {
      // Daemon-owned: the trust admin allowlist must not be rewritable by
      // the Agent (ADR-0007's structural-defense contract).
      this.store.createSurface(allowlistSurface(rules, freshness), 'job', { daemonOwned: true })
      return
    }

    // Ordered so every intermediate Surface validates (state must contain a
    // fast action's stateKey before the tree can declare it; scheduler.ts's
    // `refreshSurface` follows the same add-state -> replace-tree ->
    // remove-stale-state order): add keys, replace the list node, drop stale keys.
    const targetState = allowlistState(rules)
    const addOps: PatchOperation[] = Object.entries(targetState).flatMap(([key, value]) => {
      const alreadyPresent = Object.prototype.hasOwnProperty.call(existing.state, key)
      // A rule's Revoke state key is always `false` and never mutated by
      // this refresh in place (only added/removed as rules come and go), so
      // an unchanged value never needs a `replace` op at all.
      if (alreadyPresent && existing.state[key] === value) return []
      return [{ target: 'state', op: alreadyPresent ? 'replace' : 'add', path: `/${key}`, value }]
    })
    if (addOps.length > 0) {
      this.store.patchState(ALLOWLIST_SURFACE_ID, addOps, { updatedBy: 'job' })
    }

    const version = this.store.getSurfaceVersion(ALLOWLIST_SURFACE_ID)
    if (!version) return
    this.store.patchTree(
      ALLOWLIST_SURFACE_ID,
      [{ target: 'tree', op: 'replace', path: '/children/2', value: allowlistListNode(rules) }],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job' },
    )

    const staleOps: PatchOperation[] = Object.keys(existing.state)
      .filter((key) => ruleIdFromRevokeStateKey(key) !== undefined && !(key in targetState))
      .map((key) => ({ target: 'state', op: 'remove', path: `/${key}` }))
    if (staleOps.length > 0) {
      this.store.patchState(ALLOWLIST_SURFACE_ID, staleOps, { updatedBy: 'job' })
    }
  }
}
