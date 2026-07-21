import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { PushPayload } from '@veduta/protocol'
import webpush from 'web-push'
import { z } from 'zod'

/**
 * Web Push transport (issue #18 T4, plan decisions 9-10): the daemon's only
 * outbound delivery path for browser push notifications. `web-push` calls
 * Node's `https.request` directly, which bypasses the Undici egress
 * dispatcher (`egress.ts`) entirely — so this module, not `egress.ts`, is
 * the enforcement point for push egress. `isAllowedPushEndpoint` is checked
 * both at subscribe time (the `/api/push/subscriptions` route) and again
 * here before every send.
 */

/**
 * Static allowlist of known browser push-service hosts (docs/SECURITY.md
 * §3.4). Kept static, not fetched or config-driven: the set of vendors that
 * operate a Web Push service is small and changes rarely, and a dynamic or
 * user-suppliable policy would let a compromised or malicious subscription
 * point push egress at an arbitrary host. `suffix` entries must each start
 * with a leading dot so `endsWith` matching is label-boundary-safe (a
 * suffix of `.notify.windows.com` rejects both `evilnotify.windows.com`
 * (no dot before the shared characters) and hosts that merely embed the
 * suffix as a subdomain of an attacker-controlled parent).
 */
export const ALLOWED_PUSH_HOSTS = {
  exact: ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'],
  suffix: ['.push.services.mozilla.com', '.notify.windows.com'],
} as const

/** True iff `endpoint` is `https:` and its host matches the static allowlist above. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  const exactHosts: readonly string[] = ALLOWED_PUSH_HOSTS.exact
  if (exactHosts.includes(host)) return true
  return ALLOWED_PUSH_HOSTS.suffix.some((suffix) => host.endsWith(suffix))
}

export interface VapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

const VapidFileSchema = z.object({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
  subject: z.string().min(1),
})

/**
 * Loads `<rootDir>/vapid.json`, generating and persisting a fresh VAPID
 * keypair on first call. Idempotent: a second call with the same `rootDir`
 * returns the identical keys.
 *
 * Rationale for storing this as plaintext JSON, mode 0600, alongside the
 * daemon's other at-rest state (deviation from the adversarial review's
 * finding 6, documented here per plan decision 10): the VAPID keypair is a
 * daemon-generated *signing* key, not a third-party API key or OAuth token
 * — docs/SECURITY.md §4 (encrypted secrets vault) governs the latter, not
 * this. It follows the same at-rest model as `auth-state-file.ts`'s
 * plaintext auth state. The dev profile has no vault key material at all,
 * so vault storage would break `pnpm dev` push testing out of the box.
 * This key never enters LLM context, logs, or the Event log.
 */
export function ensureVapidKeys(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): VapidConfig {
  const path = `${rootDir}/vapid.json`
  try {
    const raw = readFileSync(path, 'utf8')
    // A restored/pre-created file may carry permissive permissions —
    // re-assert 0600 on every load, not only on first write.
    chmodSync(path, 0o600)
    return VapidFileSchema.parse(JSON.parse(raw))
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  const generated = webpush.generateVAPIDKeys()
  const email = env['VEDUTA_ACME_EMAIL']
  const keys: VapidConfig = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
    subject: email ? `mailto:${email}` : 'mailto:admin@veduta.local',
  }
  mkdirSync(rootDir, { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(VapidFileSchema.parse(keys), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(tmp, path)
  return keys
}

export interface PushSubscriptionInput {
  endpoint: string
  p256dh: string
  auth: string
}

// The wire contract lives in @veduta/protocol (PushPayloadSchema) — the
// transport re-exports the type instead of redeclaring it.
export type { PushPayload } from '@veduta/protocol'

export type PushSendResult = 'ok' | 'gone' | 'error'

export interface PushTransport {
  send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushSendResult>
}

/** The slice of the `web-push` module this transport needs — injectable so tests never hit the network. */
type WebPushImpl = Pick<typeof webpush, 'sendNotification'>

export interface WebPushTransportOptions {
  vapid: VapidConfig
  timeoutMs?: number
  webpushImpl?: WebPushImpl
}

/** Best-effort hostname for logging: never log the full endpoint, it embeds a per-subscription capability token. */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname
  } catch {
    return '<unparseable>'
  }
}

/**
 * `PushTransport` backed by the `web-push` library. The installed version
 * (3.6.7, checked against its README and `@types/web-push`) accepts a
 * `timeout` request option (socket timeout in ms) natively, so no
 * `Promise.race` wrapper is needed here.
 */
export class WebPushTransport implements PushTransport {
  private readonly vapid: VapidConfig
  private readonly timeoutMs: number
  private readonly webpushImpl: WebPushImpl

  constructor(options: WebPushTransportOptions) {
    this.vapid = options.vapid
    this.timeoutMs = options.timeoutMs ?? 10000
    this.webpushImpl = options.webpushImpl ?? webpush
  }

  async send(subscription: PushSubscriptionInput, payload: PushPayload): Promise<PushSendResult> {
    // Defense in depth: the subscribe route already rejects disallowed endpoints,
    // but this transport is the only place that is guaranteed to run before every send.
    if (!isAllowedPushEndpoint(subscription.endpoint)) {
      console.warn(
        `web-push: refusing send to disallowed endpoint host "${endpointHost(subscription.endpoint)}"`,
      )
      return 'error'
    }
    try {
      await this.webpushImpl.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        {
          vapidDetails: this.vapid,
          TTL: 3600,
          timeout: this.timeoutMs,
        },
      )
      return 'ok'
    } catch (error) {
      if (
        error instanceof webpush.WebPushError &&
        (error.statusCode === 404 || error.statusCode === 410)
      ) {
        return 'gone'
      }
      // Log only the error class and status code: an error message may echo
      // the full endpoint URL, which embeds a per-subscription capability
      // token that must never reach the logs.
      const kind =
        error instanceof webpush.WebPushError
          ? `WebPushError status ${error.statusCode}`
          : error instanceof Error
            ? error.name
            : 'unknown error'
      console.warn(
        `web-push: send failed for endpoint host "${endpointHost(subscription.endpoint)}": ${kind}`,
      )
      return 'error'
    }
  }
}
