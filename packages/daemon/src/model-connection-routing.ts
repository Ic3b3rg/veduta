import {
  loadConnectionsConfig,
  type ConnectionsFile,
  type ModelConnectionRecord,
} from './connections-config.ts'
import {
  loadRoutingConfig,
  saveRoutingConfig,
  withMockFallback,
  RuntimeRoutingConfigSchema,
  type RoutingConfig,
  type RuntimeRoutingConfig,
  type SecretResolver,
  type TierModel,
} from './model-routing.ts'

/**
 * Derives the live routing config from `connections.json` (issue #47,
 * docs/adr/0014-subscription-inference-boundary.md amendment): `base`
 * (`routing.json`) is the fallback chain a migrated install has always had.
 * A migration deliberately never sets `file.selection` (`model-connection-migration.ts`),
 * so an install with no selection routes almost exactly as before — the one
 * exception is that a base tier entry whose MATCHING migrated record exists
 * and is no longer primary-routable — either not `'connected'` (revoked,
 * expired, failed — e.g. `remove`'s env-backed tombstone) or excluded by the
 * registry's adapter policy — is dropped; an entry with no matching record
 * at all passes through unchanged (pure legacy, no Model connection was ever
 * made for it). No observable change until either the user makes a Model
 * connections choice explicit, a migrated connection's own state moves away
 * from `'connected'`, or its adapter becomes ineligible for primary routing.
 *
 * Once `file.selection` is set, BOTH tiers follow the SAME selection: the
 * ADR-0014 amendment records that triage following the visible reasoning
 * selection, rather than exposing a second picker, is the resolved
 * maintainer call. The tier array is `[activeHead?, ...fallbacks]`:
 *
 * - The selected connection contributes the head entry ONLY when it is
 *   still `state === 'connected'` and its method is in
 *   `primaryRoutableMethods` — an expired, failed, revoked, or structurally
 *   ineligible active connection is omitted rather than routed to, leaving
 *   the tier to the fallbacks alone (possibly empty, which surfaces as
 *   `NoAvailableModelError`).
 * - A fallback is any OTHER primary-routable connection that has
 *   `enabledForFallback === true` and a `selectedModelId`, in file order.
 *   `enabledForFallback` defaults to `false`, so a subscription never falls
 *   back to metered BYOK implicitly; the user opts a connection into the
 *   chain explicitly.
 *
 * `connectionKeys[connection.id]` is set to `record.secretRef` for every
 * included connection that has one (Codex is keyless by design).
 * `providerKeys` and every other field pass through from `base` unchanged.
 */
export function deriveRoutingConfig(
  base: RoutingConfig,
  file: ConnectionsFile,
  primaryRoutableMethods: ReadonlySet<ModelConnectionRecord['method']>,
): RuntimeRoutingConfig {
  const isPrimaryRoutable = (record: ModelConnectionRecord): boolean =>
    record.state === 'connected' && primaryRoutableMethods.has(record.method)

  if (!file.selection) {
    const matchingRecord = (entry: TierModel): ModelConnectionRecord | undefined =>
      file.connections.find(
        (connection) => connection.id === entry.connectionId || connection.id === entry.provider,
      )
    const dropDisconnected = (entries: TierModel[]): TierModel[] =>
      entries.filter((entry) => {
        const record = matchingRecord(entry)
        return record === undefined || isPrimaryRoutable(record)
      })
    return RuntimeRoutingConfigSchema.parse({
      ...base,
      tiers: {
        triage: dropDisconnected(base.tiers.triage),
        reasoning: dropDisconnected(base.tiers.reasoning),
      },
    })
  }

  const { selection } = file
  const active = file.connections.find((connection) => connection.id === selection.connectionId)
  const head = active && isPrimaryRoutable(active) ? active : undefined

  const fallbacks = file.connections.filter(
    (connection): connection is ModelConnectionRecord & { selectedModelId: string } =>
      connection.id !== selection.connectionId &&
      isPrimaryRoutable(connection) &&
      connection.enabledForFallback === true &&
      connection.selectedModelId !== undefined,
  )

  const entries: TierModel[] = [
    ...(head ? [tierEntry(head, selection.modelId)] : []),
    ...fallbacks.map((connection) => tierEntry(connection, connection.selectedModelId)),
  ]

  const connectionKeys: Record<string, string> = {}
  for (const connection of head ? [head, ...fallbacks] : fallbacks) {
    if (connection.secretRef !== undefined) connectionKeys[connection.id] = connection.secretRef
  }

  return RuntimeRoutingConfigSchema.parse({
    ...base,
    tiers: { triage: entries, reasoning: entries },
    connectionKeys,
  })
}

function tierEntry(connection: ModelConnectionRecord, modelId: string): TierModel {
  return { provider: connection.provider, modelId, connectionId: connection.id }
}

/**
 * The ONLY pairing of `deriveRoutingConfig` and `withMockFallback` (issue
 * #47): loads `routing.json`, derives the live config from `file`, then
 * strips/appends the mock exactly as `withMockFallback`'s own doc comment
 * describes — `mockEnabled: file.mockEnabled` and
 * `hasRealSelection: file.selection !== undefined`, so an explicit real
 * selection is never silently answered by the mock. `server.ts` calls this
 * at boot and again from the registry's `onRoutingChanged` callback, and the
 * probe bridge's throwaway candidate config, rather than composing the two
 * functions by hand at each call site.
 */
export function buildRuntimeRouting(deps: {
  rootDir: string
  file: ConnectionsFile
  secrets: SecretResolver
  profile: 'loopback' | 'local-vps' | 'vps'
  primaryRoutableMethods: ReadonlySet<ModelConnectionRecord['method']>
}): RuntimeRoutingConfig {
  const base = loadRoutingConfig(deps.rootDir)
  const derived = deriveRoutingConfig(base, deps.file, deps.primaryRoutableMethods)
  return withMockFallback(derived, deps.secrets, {
    profile: deps.profile,
    mockEnabled: deps.file.mockEnabled,
    hasRealSelection: deps.file.selection !== undefined,
  })
}

/**
 * Drops every `routing.json` `connectionKeys` entry whose id has no matching
 * `connections.json` record (issue #47): a legacy hand-edited or
 * pre-this-fix `routing.json` may still carry a stale pointer — `provider-api-key.ts`'s
 * `storeConnectionApiKey` no longer writes here at all, and
 * `model-connection-registry.ts`'s `remove` drops a single id's entry
 * directly, but neither of those covers a `routing.json` that already had
 * orphan entries before either fix shipped. `server.ts` calls this once at
 * boot, right after the BYOK migration reconcile. Saves only when the set of
 * entries actually changed, returning whether it did.
 */
export function pruneOrphanConnectionKeys(rootDir: string): boolean {
  const routing = loadRoutingConfig(rootDir)
  const file = loadConnectionsConfig(rootDir)
  const validIds = new Set(file.connections.map((connection) => connection.id))
  const entries = Object.entries(routing.connectionKeys).filter(([id]) => validIds.has(id))
  if (entries.length === Object.keys(routing.connectionKeys).length) return false
  saveRoutingConfig(rootDir, { ...routing, connectionKeys: Object.fromEntries(entries) })
  return true
}

/**
 * Holds the daemon's one live `RuntimeRoutingConfig` (issue #47's live-apply
 * path): the registry's `onRoutingChanged` calls `replace()` with a freshly
 * derived config after every mutation that can change routing, and
 * `server.ts` feeds `current()` to the provider bridge's `config` getter so
 * the very next turn sees it — no daemon restart required.
 */
export class RoutingState {
  private config: RuntimeRoutingConfig

  constructor(initial: RuntimeRoutingConfig) {
    this.config = initial
  }

  current(): RuntimeRoutingConfig {
    return this.config
  }

  replace(next: RuntimeRoutingConfig): void {
    this.config = next
  }
}

/**
 * The canonical provider names egress policy must allow (`server.ts`'s
 * `assembleEgressPolicy`, issue #47): every `providerKeys` key AND every
 * `connectionKeys` key, each mapped through `file.connections` back onto
 * its canonical provider — a migrated connection's id already IS the
 * provider name, a new connection's id is a uuid that only the file can
 * resolve. A `providerKeys` key with no matching connection record (the pure
 * legacy path) resolves to itself, unchanged — but a `connectionKeys` id
 * with no matching record is skipped entirely (issue #47): unlike a
 * provider name, a bare connection id (a uuid, or an orphaned legacy id) is
 * never itself a canonical provider name egress could allow a host for, so
 * falling back to the raw key the way `providerKeys` does would let a stale
 * `routing.json` entry (see `pruneOrphanConnectionKeys`) leak a meaningless
 * "provider" into the allowlist instead of just being ignored.
 */
export function egressProvidersFor(config: RuntimeRoutingConfig, file: ConnectionsFile): string[] {
  const providers = new Set<string>()
  for (const key of Object.keys(config.providerKeys)) {
    providers.add(file.connections.find((connection) => connection.id === key)?.provider ?? key)
  }
  for (const key of Object.keys(config.connectionKeys)) {
    const provider = file.connections.find((connection) => connection.id === key)?.provider
    if (provider !== undefined) providers.add(provider)
  }
  return [...providers]
}
