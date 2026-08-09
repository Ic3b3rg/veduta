import { ByokProviderSchema } from '@veduta/protocol'
import {
  loadConnectionsConfig,
  saveConnectionsConfig,
  type ModelConnectionRecord,
} from './connections-config.ts'
import { PROVIDER_DISPLAY_NAMES } from './model-connection-byok.ts'
import type { RoutingConfig, SecretResolver } from './model-routing.ts'

/**
 * BYOK-to-Model-connections migration (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment). A
 * pre-Model-connections install keeps its provider keys in `routing.json`'s
 * `providerKeys`, with no `connections.json` record for them at all —
 * `getApiKey`/`candidates()` (`model-routing.ts`) resolve them directly by
 * provider name, and there was never anything to show the user. This turns
 * each provider key that still resolves into a `connected` legacy
 * connection under the reserved provider id (`id === provider`), so the
 * same key becomes a visible, revocable, fallback-eligible Model
 * connection.
 *
 * Deliberately writes ONLY `connections.json` — `routing.json` is never
 * touched, and `selection` is never set on the file it writes. Every
 * migrated record's `secretRef` is the exact `providerKeys` value it came
 * from, copied verbatim (`secret://vault/...` and `secret://env/...`
 * alike), so nothing has to move and nothing about how that key resolves
 * changes. `model-connection-routing.ts`'s `deriveRoutingConfig` returns the
 * base routing config completely unchanged whenever `file.selection` is
 * absent, so a freshly migrated install routes byte-identically to how it
 * routed the moment before migration ran (issues/047-model-connections.md)
 * — the only observable change is that the connection now exists.
 *
 * Idempotent: a provider that already has a connection record — its own
 * legacy id from an earlier run of this same function, or a uuid a real
 * Model connection flow already created for it — is left untouched, and a
 * `providerKeys` entry whose secret does not currently resolve (no vault
 * entry, no environment variable set — the shipped default, before any key
 * was ever configured) is skipped rather than turned into a connection
 * nobody could actually use.
 *
 * Called identically from two places: once at daemon boot (`server.ts`,
 * covering a legacy install that upgrades in place) and once from the
 * importer (`import-apply.ts`'s `ImportConnectionSink`, covering a key that
 * arrives through a legacy-home import instead) — so a key reconciled
 * either way ends up as the exact same kind of record.
 *
 * Returns whether `connections.json` was written, so a caller that wants to
 * know need not re-read and diff the file itself.
 */
export function reconcileByokConnections(deps: {
  rootDir: string
  routing: RoutingConfig
  secrets: SecretResolver
  now: () => Date
}): boolean {
  const file = loadConnectionsConfig(deps.rootDir)
  let connections = file.connections
  let changed = false

  for (const provider of ByokProviderSchema.options) {
    if (connections.some((connection) => connection.id === provider)) continue

    const ref = deps.routing.providerKeys[provider]
    if (ref === undefined) continue
    // An unresolved default is not a connection: creating a "connected"
    // record for a key that cannot actually resolve would show the user a
    // method they can never use.
    if (deps.secrets.resolve(ref) === undefined) continue

    const stateAt = deps.now().toISOString()
    const selectedModelId = deps.routing.tiers.reasoning.find(
      (entry) => entry.provider === provider,
    )?.modelId

    const record: ModelConnectionRecord = {
      id: provider,
      method: `${provider}-api-key`,
      provider,
      label: `${PROVIDER_DISPLAY_NAMES[provider]} · API key`,
      state: 'connected',
      stateAt,
      createdAt: stateAt,
      enabledForFallback: false,
      // Copied verbatim, never rewritten to a vault-style reference: an
      // env-backed migrated connection must keep resolving through
      // `secret://env/...` exactly as it always did.
      secretRef: ref,
      ...(selectedModelId === undefined ? {} : { selectedModelId }),
    }
    connections = [...connections, record]
    changed = true
  }

  if (!changed) return false
  saveConnectionsConfig(deps.rootDir, { ...file, connections })
  return true
}
