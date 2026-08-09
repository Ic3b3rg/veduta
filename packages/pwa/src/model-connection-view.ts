import type { DeviceChallenge, ModelConnection, ModelConnectionsSnapshot } from '@veduta/protocol'

/**
 * Pure presentation logic for the Model connections panel (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md`): select-option labels,
 * lifecycle copy, catalog rendering, and the "can I continue" gate. No DOM
 * access, no fetch -- `model-connection-panel.tsx` is the only caller that
 * touches the network, following the `onboarding-state.ts` convention of
 * keeping wizard/panel logic unit-testable without a browser.
 */

/** Display name for the three BYOK providers; a novel provider string falls back to itself (`providerDisplayName`). */
export const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Claude',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
}

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider
}

/**
 * Method-id to display name, mirroring the daemon's own adapter metadata
 * (`packages/daemon/src/model-connection-byok.ts`,
 * `model-connection-claude.ts`) rather than re-deriving it: every BYOK method
 * id ends in `-api-key` and reads "API key"; the two subscription methods
 * each have their own fixed copy.
 */
function methodDisplayName(methodId: ModelConnection['method']): string {
  if (methodId.endsWith('-api-key')) return 'API key'
  if (methodId === 'chatgpt-codex') return 'ChatGPT subscription'
  return 'Subscription'
}

/**
 * The label for one connection inside the Connection select (issue #47): a
 * provider with a single connection needs no disambiguation at all; more
 * than one collapses to provider + method; and if that still collides (two
 * connections on the same provider AND the same method -- e.g. two Claude
 * API keys) the connection's own user-chosen label is appended as the last
 * resort.
 */
export function connectionSelectLabel(connection: ModelConnection, all: ModelConnection[]): string {
  const siblings = all.filter((candidate) => candidate.provider === connection.provider)
  if (siblings.length <= 1) return providerDisplayName(connection.provider)

  const label = `${providerDisplayName(connection.provider)} · ${methodDisplayName(connection.method)}`
  const sameMethodSiblings = siblings.filter((candidate) => candidate.method === connection.method)
  if (sameMethodSiblings.length <= 1) return label

  return `${label} · ${connection.label}`
}

export interface LifecycleCopy {
  title: string
  detail: string
  action: 'none' | 'authorize' | 'reconnect' | 'retry'
}

/**
 * Honest, state-specific copy for the nine Model connection lifecycle states
 * (`ConnectionLifecycleStateSchema`, issue #47). `detail` never invents a
 * fact the connection record does not carry: `connected` reports the account
 * label only when the adapter supplied one, and `failed` shows the adapter's
 * own `stateReason` verbatim rather than a generic message.
 */
export function lifecycleCopy(connection: ModelConnection): LifecycleCopy {
  switch (connection.state) {
    case 'available':
      return {
        title: 'Not connected',
        detail: 'Add this connection to start using it.',
        action: 'authorize',
      }
    case 'authorizing':
      return {
        title: 'Authorizing…',
        detail: 'Confirming the key or starting sign-in with the provider…',
        action: 'none',
      }
    case 'waiting-for-user':
      return {
        title: 'Waiting for you to finish signing in…',
        detail: 'Complete sign-in using the verification link and code below.',
        action: 'none',
      }
    case 'verifying':
      return {
        title: 'Verifying…',
        detail: 'Running a live check against the provider before marking this usable.',
        action: 'none',
      }
    case 'connected':
      return {
        title: 'Connected',
        detail:
          connection.account?.label !== undefined
            ? `Signed in as ${connection.account.label}.`
            : 'Ready to use.',
        action: 'none',
      }
    case 'expired':
      return {
        title: 'Expired',
        detail:
          connection.stateReason ??
          'The credential stopped working and an automatic refresh has not recovered it yet.',
        action: 'reconnect',
      }
    case 'reconnecting':
      return {
        title: 'Reconnecting…',
        detail: 'Automatically refreshing the credential…',
        action: 'none',
      }
    case 'failed':
      return {
        title: 'Failed',
        detail: connection.stateReason ?? 'Authorization or verification failed.',
        action: 'retry',
      }
    case 'revoked':
      return {
        title: 'Revoked',
        detail:
          connection.stateReason ?? 'This connection was revoked and needs to be reconnected.',
        action: 'reconnect',
      }
  }
}

export interface CatalogOption {
  value: string
  label: string
  disabled: boolean
  note?: string
}

/**
 * The full catalog a connection's `verify`/`catalog` call reported, with no
 * curated subset (issue #47: "show the full returned catalog without a
 * curated subset"). A model this build cannot route to (`routable: false`)
 * is disabled rather than hidden, with the exact note the daemon-side
 * catalog hardening promises.
 */
export function catalogOptions(connection: ModelConnection): CatalogOption[] {
  return (connection.catalog ?? []).map((entry) => ({
    value: entry.id,
    label: entry.label,
    disabled: entry.routable === false,
    ...(entry.routable === false ? { note: 'not routable by this build' } : {}),
  }))
}

/**
 * Whether the Model connection step (or panel) can be considered done for
 * `profile` (issue #47, ADR-0014 amendment): loopback never blocks (the
 * built-in mock provider is always available there); Local VPS accepts
 * either a verified selection on a connected connection or the explicit
 * development mock control; a real VPS requires an actual selection whose
 * connection is connected -- the mock control does not exist there.
 */
export function canContinue(
  snapshot: ModelConnectionsSnapshot,
  profile: 'loopback' | 'local-vps' | 'vps',
): boolean {
  if (profile === 'loopback') return true

  if (profile === 'local-vps') {
    const hasConnected = snapshot.connections.some((connection) => connection.state === 'connected')
    return (hasConnected && snapshot.selection !== null) || snapshot.mockEnabled
  }

  if (snapshot.selection === null) return false
  const selected = snapshot.connections.find(
    (connection) => connection.id === snapshot.selection?.connectionId,
  )
  return selected?.state === 'connected'
}

/** 'expires in M:SS', or 'expired' once `now` has passed the challenge's expiry -- the same rendering the daemon's countdown deadline assumes the PWA stops polling at. */
export function challengeCountdownLabel(challenge: DeviceChallenge, now: Date): string {
  const remainingMs = Date.parse(challenge.expiresAt) - now.getTime()
  if (remainingMs <= 0) return 'expired'

  const totalSeconds = Math.floor(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `expires in ${minutes}:${seconds.toString().padStart(2, '0')}`
}
