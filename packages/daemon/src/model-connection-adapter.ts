import type {
  ConnectionLifecycleState,
  DeviceChallenge,
  ModelCatalogEntry,
  ModelConnectionMethodId,
} from '@veduta/protocol'
import type { CodexTransportFactory } from './codex-app-server.ts'
import { sanitizeErrorText, type SecretResolver } from './model-routing.ts'
import type { SubscriptionStreamEvent, SubscriptionStreamRequest } from './pi-provider-bridge.ts'
import type { SecretsVault } from './secrets-vault.ts'

/**
 * The Gateway-owned contract every Model connection adapter implements
 * (issue #47, docs/adr/0014-subscription-inference-boundary.md). BYOK, the
 * Claude subscription gate, and Codex each get their own module
 * (`model-connection-byok.ts`, `model-connection-claude.ts`,
 * `model-connection-codex.ts`); `model-connection-registry.ts` is the only
 * caller. This module holds types and errors only — no adapter
 * implementation, no I/O.
 */

export interface ModelConnectionCapabilities {
  authorization: 'api-key' | 'device-code' | 'none'
  refresh: 'automatic' | 'static'
  revocation: 'provider' | 'local-only'
  /** Metered spend is possible on this method (BYOK, or a subscription with usage credits). */
  metered: boolean
}

export interface AdapterEnv {
  rootDir: string
  env: NodeJS.ProcessEnv
  vaultAvailable: boolean
}

/**
 * A function of the environment, never persisted state: the Claude gate
 * and a missing/mis-versioned Codex binary both render as `available:
 * false` with a reason and an optional docs link, so the PWA never
 * hardcodes per-provider unavailability behavior.
 */
export type AdapterAvailability =
  { available: true } | { available: false; reason: string; docsUrl?: string }

export interface AdapterContext {
  connectionId: string
  rootDir: string
  vault: SecretsVault | undefined
  /**
   * Resolves any `secret://…` reference the same way the router does
   * (issue #47): a BYOK adapter's `catalog`/`refresh` never opens the vault
   * directly, so a vault-backed and an env-backed key (`secret://env/…`,
   * kept alive by a migrated legacy install) work through the identical
   * code path.
   */
  secrets: SecretResolver
  fetchImpl: typeof fetch
  now: () => Date
  /** One real inference call through the production path. */
  probe: (modelId: string) => Promise<void>
  /** Per-connection Codex credential dir, `<rootDir>/codex/<connectionId>`; created 0700, empty. */
  codexHome: string
  /**
   * Injectable JSON-RPC seam to this connection's Codex app-server
   * transport (issue #47): `model-connection-registry.ts`'s `contextFor`
   * binds it to a `CodexSessionPool`-backed accessor closed over this
   * connection's id, so `model-connection-codex.ts` never spawns anything
   * itself and every other adapter simply never reads it. Absent for a
   * connection whose method is not Codex.
   */
  codexTransport?: CodexTransportFactory
  /**
   * The record's own secret reference, supplied by the registry (issue #47,
   * `docs/adr/0014-…` amendment: for a non-api-key adapter the original
   * `secret://vault/…` or `secret://env/…` reference is preserved verbatim,
   * never re-derived; an api-key adapter's successful authorize always
   * repoints it at this connection's own vault entry instead, per
   * `model-connection-registry.ts`'s `runAuthorization`). Absent for a
   * connection that has never stored a key (a fresh device-code connection,
   * or a BYOK connection created without one yet).
   */
  secretRef?: string
}

export type AuthorizeInput = { apiKey?: string }

export type AuthorizeResult =
  | { state: 'connected'; account?: { label: string } }
  | { state: 'waiting-for-user'; challenge: DeviceChallenge }

export interface RefreshResult {
  state: ConnectionLifecycleState
  account?: { label: string }
  reason?: string
}

export interface SubscriptionPrimaryModelInference {
  readonly transport: 'subscription'
  stream(
    ctx: AdapterContext,
    request: SubscriptionStreamRequest,
  ): AsyncIterable<SubscriptionStreamEvent>
}

export type PrimaryModelInference =
  | { readonly transport: 'builtin' }
  | SubscriptionPrimaryModelInference
  | { readonly transport: 'unavailable'; readonly reason: string; readonly docsUrl?: string }

export interface ModelConnectionAdapter {
  readonly methodId: ModelConnectionMethodId
  /** The canonical provider name — feeds pi-ai model resolution and PROVIDER_HOSTS. Never a connection id. */
  readonly providerName: string
  readonly providerDisplayName: string
  readonly methodDisplayName: string
  readonly capabilities: ModelConnectionCapabilities
  /**
   * The adapter's complete primary-Agent inference route. This is a
   * transport choice, not an optional Agent capability: both routable
   * variants receive the same AgentRunner tool contract, while an adapter
   * with no such route is excluded from primary routing.
   */
  readonly primaryInference: PrimaryModelInference
  /** Async and cacheable per process for a routable declaration: a Codex binary/version probe happens here, at snapshot time. */
  availability(env: AdapterEnv): Promise<AdapterAvailability>
  authorize(ctx: AdapterContext, input: AuthorizeInput): Promise<AuthorizeResult>
  /** Poll a device-code login, refresh a credential, or re-check a connected one. */
  refresh(ctx: AdapterContext, challenge?: DeviceChallenge): Promise<RefreshResult>
  catalog(ctx: AdapterContext): Promise<ModelCatalogEntry[]>
  verify(ctx: AdapterContext, modelId: string): Promise<void>
  revoke(ctx: AdapterContext): Promise<{ providerRevoked: boolean; note?: string }>
}

export type SubscriptionModelConnectionAdapter = Omit<
  ModelConnectionAdapter,
  'primaryInference'
> & {
  readonly primaryInference: SubscriptionPrimaryModelInference
}

export type RoutablePrimaryModelInference = Exclude<
  PrimaryModelInference,
  { readonly transport: 'unavailable' }
>

export type PrimaryRouteEligibility =
  | { readonly routable: true; readonly inference: RoutablePrimaryModelInference }
  | { readonly routable: false; readonly reason: string; readonly docsUrl?: string }

/** The single policy boundary that turns an adapter declaration into primary-route eligibility. */
export function primaryRouteEligibility(
  adapter: Pick<ModelConnectionAdapter, 'primaryInference'>,
): PrimaryRouteEligibility {
  const inference = adapter.primaryInference
  if (inference.transport !== 'unavailable') return { routable: true, inference }
  return {
    routable: false,
    reason: inference.reason,
    ...(inference.docsUrl === undefined ? {} : { docsUrl: inference.docsUrl }),
  }
}

export type ModelConnectionErrorCode =
  'unauthorized' | 'expired' | 'rejected' | 'unreachable' | 'unsupported' | 'internal'

export class ModelConnectionError extends Error {
  constructor(
    readonly code: ModelConnectionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ModelConnectionError'
  }
}

/** `true` for anything shaped like a fetch failure, an aborted request, or a timed-out one. */
function isConnectivityFailure(error: unknown): boolean {
  if (error instanceof TypeError && error.message === 'fetch failed') return true
  const name = hasStringName(error) ? error.name : undefined
  return name === 'AbortError' || name === 'TimeoutError'
}

function hasStringName(error: unknown): error is { name: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    typeof (error as { name: unknown }).name === 'string'
  )
}

/**
 * Normalizes any thrown value into a `ModelConnectionError`. A fetch-failure
 * shape — a `TypeError` reporting `fetch failed`, an `AbortError`, or a
 * timed-out `DOMException` — maps to `'unreachable'`; everything else maps
 * to `'internal'`. The message ALWAYS goes through `sanitizeErrorText`
 * first, so a provider error embedding a registered secret is redacted
 * before it ever reaches a caller. An existing `ModelConnectionError` keeps
 * its code but is NOT passed through unchanged (issue #47): its own
 * message goes through `sanitizeErrorText` too, into a NEW error — a
 * transport that lifts a child process's own text verbatim into
 * `ModelConnectionError` (e.g. `codex-app-server.ts`'s JSON-RPC error
 * handling before this fix) must not have that text survive un-sanitized
 * just because it already arrives wrapped.
 */
export function connectionErrorFrom(error: unknown): ModelConnectionError {
  if (error instanceof ModelConnectionError) {
    return new ModelConnectionError(error.code, sanitizeErrorText(error))
  }
  const code: ModelConnectionErrorCode = isConnectivityFailure(error) ? 'unreachable' : 'internal'
  return new ModelConnectionError(code, sanitizeErrorText(error))
}
