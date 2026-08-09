import type { ConnectionsFile, ModelConnectionRecord } from './connections-config.ts'
import {
  RuntimeRoutingConfigSchema,
  type RoutingConfig,
  type RuntimeRoutingConfig,
  type TierModel,
} from './model-routing.ts'

/**
 * Derives the live routing config from `connections.json` (issue #47,
 * docs/adr/0014-subscription-inference-boundary.md amendment): `base`
 * (`routing.json`) is the fallback chain a migrated install has always had.
 * A migration deliberately never sets `file.selection` (`model-connection-migration.ts`),
 * so an install with no selection routes exactly as before — no observable
 * change until the user makes a Model connections choice explicit.
 *
 * Once `file.selection` is set, BOTH tiers follow the SAME selection: the
 * ADR-0014 amendment records that triage following the visible reasoning
 * selection, rather than exposing a second picker, is the resolved
 * maintainer call. The tier array is `[activeHead?, ...fallbacks]`:
 *
 * - The selected connection contributes the head entry ONLY when it is
 *   still `state === 'connected'` — an expired, failed or revoked active
 *   connection is omitted rather than routed to (a stale credential must
 *   never be attempted), leaving the tier to the fallbacks alone (possibly
 *   empty, which surfaces as `NoAvailableModelError`).
 * - A fallback is any OTHER connection that is `state === 'connected'`,
 *   `enabledForFallback === true`, and has a `selectedModelId` — in file
 *   order. `enabledForFallback` defaults to `false`, so a subscription
 *   never falls back to metered BYOK implicitly; the user opts a
 *   connection into the chain explicitly.
 *
 * `connectionKeys[connection.id]` is set to `record.secretRef` for every
 * included connection that has one (Codex is keyless by design).
 * `providerKeys` and every other field pass through from `base` unchanged.
 */
export function deriveRoutingConfig(
  base: RoutingConfig,
  file: ConnectionsFile,
): RuntimeRoutingConfig {
  if (!file.selection) return RuntimeRoutingConfigSchema.parse(base)

  const { selection } = file
  const active = file.connections.find((connection) => connection.id === selection.connectionId)
  const head = active && active.state === 'connected' ? active : undefined

  const fallbacks = file.connections.filter(
    (connection): connection is ModelConnectionRecord & { selectedModelId: string } =>
      connection.id !== selection.connectionId &&
      connection.state === 'connected' &&
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
 * resolve. A key with no matching connection record (the legacy
 * `providerKeys` path) resolves to itself, unchanged.
 */
export function egressProvidersFor(config: RuntimeRoutingConfig, file: ConnectionsFile): string[] {
  const toProvider = (key: string): string =>
    file.connections.find((connection) => connection.id === key)?.provider ?? key
  const providers = new Set<string>()
  for (const key of Object.keys(config.providerKeys)) providers.add(toProvider(key))
  for (const key of Object.keys(config.connectionKeys)) providers.add(toProvider(key))
  return [...providers]
}
