import {
  AuthSessionSchema,
  AuthStatusSchema,
  ByokTestResponseSchema,
  FinishResponseSchema,
  GatewayServerMessageSchema,
  ImportApplyResponseSchema,
  ImportPlanSchema,
  OnboardingStatusSchema,
  SurfaceSnapshotSchema,
  SurfaceSchema,
  WebAuthnOptionsEnvelopeSchema,
  type AtomNode,
  type AuthSession,
  type AuthStatus,
  type ByokApplyRequest,
  type ByokTestRequest,
  type ByokTestResponse,
  type FinishResponse,
  type FirstSpaceRequest,
  type GatewayServerMessage,
  type ImportApplyRequest,
  type ImportApplyResponse,
  type ImportPlan,
  type ImportPreviewRequest,
  type IntegrationsApplyRequest,
  type JsonObject,
  type JsonValue,
  type MigrationChoiceRequest,
  type ModelsApplyRequest,
  type OnboardingStatus,
  type Surface,
  type SurfaceArchivedEvent,
  type SurfaceCreatedEvent,
  type SurfacePatchEvent,
  type SurfacePinnedEvent,
  type SurfaceSnapshot,
} from '@veduta/protocol'
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import { z } from 'zod'

// The PWA never trusts the wire blindly (AGENTS.md): every response is
// validated with the protocol schemas before it reaches a component.
export type SpaceWithSurfaces = SurfaceSnapshot['spaces'][number]

const SurfaceActionResponseSchema = z.union([
  z.object({ surface: SurfaceSchema }),
  z.object({ turn: z.object({ id: z.string().min(1) }).passthrough() }),
])

export type SurfaceActionResponse = z.infer<typeof SurfaceActionResponseSchema>

export interface GatewayConnection {
  close(): void
  sendChat(text: string, spaceId?: string): boolean
}

export interface GatewayHandlers {
  token?: string | undefined
  /**
   * The clientId this same tab was assigned by a previous `hello` (issue
   * 037), if any. Sent back on the reconnect `hello` so the daemon's
   * `GatewayHub` re-binds the same session to the new socket instead of
   * allocating a fresh id -- otherwise a turn started before the drop keeps
   * addressing its `chat.turn-end` to a clientId nothing is listening on
   * anymore (`GatewayHub.sendToClient` silently no-ops for an unknown
   * client). Omitted on the very first connection of a tab.
   */
  clientId?: string | undefined
  surfaceCursor: number
  onHello(cursor: number, clientId: string): void
  onSurfacePatch(event: SurfacePatchEvent): void
  onSurfaceCreated(event: SurfaceCreatedEvent): void
  onSurfaceArchived(event: SurfaceArchivedEvent): void
  onSurfacePinned(event: SurfacePinnedEvent): void
  onChatMessage(message: Extract<GatewayServerMessage, { type: 'chat.message' }>): void
  onChatTurnStart(message: Extract<GatewayServerMessage, { type: 'chat.turn-start' }>): void
  onChatTurnDelta(message: Extract<GatewayServerMessage, { type: 'chat.turn-delta' }>): void
  onChatTurnEnd(message: Extract<GatewayServerMessage, { type: 'chat.turn-end' }>): void
  onChatTurnError(message: Extract<GatewayServerMessage, { type: 'chat.turn-error' }>): void
  onApprovalCard(message: Extract<GatewayServerMessage, { type: 'approval.card' }>): void
  onPresence(message: Extract<GatewayServerMessage, { type: 'presence.update' }>): void
  onSpaceAttention(message: Extract<GatewayServerMessage, { type: 'space.attention' }>): void
  onError(message: string): void
  onClose(): void
}

const SpaceAttentionSeenResponseSchema = z.object({
  count: z.number().int().min(0),
  revision: z.number().int().min(0),
})

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error(`GET /api/auth/status failed: ${res.status}`)
  return AuthStatusSchema.parse(await res.json())
}

export async function fetchSpaces(token?: string): Promise<SurfaceSnapshot> {
  const res = await fetch('/api/spaces', { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`GET /api/spaces failed: ${res.status}`)
  return SurfaceSnapshotSchema.parse(await res.json())
}

// Onboarding wizard (issue 019): every response is zod-parsed against
// `@veduta/protocol`'s onboarding schemas before it reaches
// `onboarding-state.ts` or a wizard component.

export async function fetchOnboardingStatus(token?: string): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await getJson('/api/onboarding', token))
}

export async function submitMigrationChoice(
  choice: MigrationChoiceRequest['choice'],
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(
    await postJson('/api/onboarding/migration', { choice }, token),
  )
}

/**
 * `POST /api/onboarding/migration/preview` (issue 020): a pure dry-run that
 * writes nothing to source or target -- this helper only reads the returned
 * plan, it never mutates anything itself. `request.overwrite` must match
 * whatever the wizard is about to apply: re-preview on every toggle rather
 * than reusing a stale plan.
 */
export async function previewLegacyImport(
  request: ImportPreviewRequest,
  token?: string,
): Promise<ImportPlan> {
  return ImportPlanSchema.parse(await postJson('/api/onboarding/migration/preview', request, token))
}

/**
 * `POST /api/onboarding/migration/import`: recomputes and actually applies
 * the plan for one legacy source. The
 * response's `status` is a fresh `GET`-equivalent (a successful import sets
 * `migrationChoice: 'imported'` and completes the `migration` step), so the
 * caller does not need a second round trip to advance the wizard.
 */
export async function runLegacyImport(
  request: ImportApplyRequest,
  token?: string,
): Promise<ImportApplyResponse> {
  return ImportApplyResponseSchema.parse(
    await postJson('/api/onboarding/migration/import', request, token),
  )
}

export async function confirmDomainStep(token?: string): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await postJson('/api/onboarding/domain', {}, token))
}

export async function testByokKey(
  request: ByokTestRequest,
  token?: string,
): Promise<ByokTestResponse> {
  return ByokTestResponseSchema.parse(await postJson('/api/onboarding/byok/test', request, token))
}

export async function applyByokStep(
  request: ByokApplyRequest,
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await postJson('/api/onboarding/byok', request, token))
}

export async function applyModelsStep(
  tiers: ModelsApplyRequest['tiers'],
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await postJson('/api/onboarding/models', { tiers }, token))
}

export async function applyFirstSpaceStep(
  request: FirstSpaceRequest,
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await postJson('/api/onboarding/first-space', request, token))
}

export async function applyIntegrationsStep(
  request: IntegrationsApplyRequest,
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(
    await postJson('/api/onboarding/integrations', request, token),
  )
}

export async function finishOnboarding(token?: string): Promise<FinishResponse> {
  return FinishResponseSchema.parse(await postJson('/api/onboarding/finish', {}, token))
}

/** Clears a Space's attention badge on focus (ADR): the
 * daemon appends a `notification.seen` event only when count > 0, so callers
 * should only invoke this when the Space currently has attention to clear. */
export async function markSpaceAttentionSeen(
  spaceId: string,
  token?: string,
): Promise<{ count: number; revision: number }> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/attention/seen`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  if (!res.ok) {
    throw new Error(`POST /api/spaces/${spaceId}/attention/seen failed: ${res.status}`)
  }
  return SpaceAttentionSeenResponseSchema.parse(await res.json())
}

const PinSurfaceResponseSchema = z.object({ surface: SurfaceSchema })

/** Toggles a Surface's pin (CONTEXT.md's Pin: "I like this Surface as it
 * is"). The daemon 404s an unknown Surface and 409s one that isn't
 * pinnable (daemon-owned, the projected FACTS Surface); both come back
 * through `errorMessageFromBody` as a readable message rather than a bare
 * status code. */
export async function pinSurface(
  surfaceId: string,
  pinned: boolean,
  token?: string,
): Promise<Surface> {
  const body = await postJson(`/api/surfaces/${surfaceId}/pin`, { pinned }, token)
  return PinSurfaceResponseSchema.parse(body).surface
}

export async function invokeFastAction(
  surfaceId: string,
  nodeId: string,
  name: string,
  value: JsonValue,
  token?: string,
  idempotencyKey?: string,
): Promise<Surface> {
  const result = await invokeSurfaceAction(
    surfaceId,
    nodeId,
    name,
    { value },
    token,
    idempotencyKey,
  )
  if ('surface' in result) return result.surface
  throw new Error(`fast action "${name}" did not return a Surface`)
}

export async function invokeSurfaceAction(
  surfaceId: string,
  nodeId: string,
  name: string,
  payload?: JsonObject,
  token?: string,
  idempotencyKey?: string,
): Promise<SurfaceActionResponse> {
  const res = await fetch(`/api/surfaces/${surfaceId}/actions`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId,
      name,
      ...(payload === undefined ? {} : { payload }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  })
  if (!res.ok) throw new Error(`Surface action failed: ${res.status}`)
  return SurfaceActionResponseSchema.parse(await res.json())
}

export function optimisticFastSurface(
  surface: Surface,
  node: AtomNode,
  actionName: string,
  value: JsonValue,
  updatedAt = new Date().toISOString(),
): Surface {
  const action = node.actions?.find((candidate) => candidate.name === actionName)
  if (action?.path !== 'fast' || action.stateKey === undefined) return surface

  return SurfaceSchema.parse({
    ...surface,
    state: { ...surface.state, [action.stateKey]: value },
    freshness: { updatedAt, updatedBy: 'user' },
  })
}

export function fastActionIdempotencyKey(input: {
  surfaceId: string
  surfaceUpdatedAt: string
  nodeId: string
  actionName: string
  value: JsonValue
}): string {
  const raw = JSON.stringify(input)
  let hash = 0x811c9dc5
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fast-${(hash >>> 0).toString(36)}-${raw.length.toString(36)}`
}

export function connectGateway(handlers: GatewayHandlers): GatewayConnection {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const ws = new WebSocket(`${protocol}//${location.host}/ws/gateway`)

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        surfaceCursor: handlers.surfaceCursor,
        token: handlers.token,
        ...(handlers.clientId ? { clientId: handlers.clientId } : {}),
      }),
    )
  }

  ws.onmessage = (event) => {
    const message = parseGatewayMessage(event.data)
    if (!message) return

    if (message.type === 'hello') {
      handlers.onHello(message.surfaceCursor, message.clientId)
      return
    }

    if (message.type === 'surface.patch') {
      handlers.onSurfacePatch(message.event)
      return
    }

    if (message.type === 'surface.created') {
      handlers.onSurfaceCreated(message.event)
      return
    }

    if (message.type === 'surface.archived') {
      handlers.onSurfaceArchived(message.event)
      return
    }

    if (message.type === 'surface.pinned') {
      handlers.onSurfacePinned(message.event)
      return
    }

    if (message.type === 'chat.message') {
      handlers.onChatMessage(message)
      return
    }

    if (message.type === 'chat.turn-start') {
      handlers.onChatTurnStart(message)
      return
    }

    if (message.type === 'chat.turn-delta') {
      handlers.onChatTurnDelta(message)
      return
    }

    if (message.type === 'chat.turn-end') {
      handlers.onChatTurnEnd(message)
      return
    }

    if (message.type === 'chat.turn-error') {
      handlers.onChatTurnError(message)
      return
    }

    if (message.type === 'approval.card') {
      handlers.onApprovalCard(message)
      return
    }

    if (message.type === 'presence.update') {
      handlers.onPresence(message)
      return
    }

    if (message.type === 'space.attention') {
      handlers.onSpaceAttention(message)
      return
    }

    if (message.type === 'error') handlers.onError(message.error)
  }

  ws.onclose = () => handlers.onClose()

  return {
    close() {
      ws.close()
    },
    sendChat(text, spaceId) {
      if (ws.readyState !== WebSocket.OPEN) return false
      ws.send(JSON.stringify({ type: 'chat.send', text, ...(spaceId ? { spaceId } : {}) }))
      return true
    },
  }
}

export async function registerPasskey(input: {
  oneTimeCode: string
  deviceName: string
}): Promise<AuthSession> {
  const envelope = await postJson('/api/auth/register/options', input)
  const parsed = WebAuthnOptionsEnvelopeSchema.parse(envelope)
  const response = await startRegistration({
    optionsJSON: parsed.options as PublicKeyCredentialCreationOptionsJSON,
  })
  return verifyRegistration(parsed.ceremonyId, response)
}

export async function loginWithPasskey(deviceName: string): Promise<AuthSession> {
  const envelope = await postJson('/api/auth/login/options', {})
  const parsed = WebAuthnOptionsEnvelopeSchema.parse(envelope)
  const response = await startAuthentication({
    optionsJSON: parsed.options as PublicKeyCredentialRequestOptionsJSON,
  })
  return verifyLogin(parsed.ceremonyId, response, deviceName)
}

/** Human-readable freshness, shown on every Surface (ADR-0005). */
export function freshnessLabel(updatedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}

/** Human-readable expiry for an approval chip: the chip is a pure
 * notification, the decision UI lives on the card Surface itself. */
export function expiresInLabel(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now
  if (ms <= 0) return 'expired'
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `expires in ${minutes}m`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `expires in ${hours}h` : `expires in ${Math.round(hours / 24)}d`
}

function parseGatewayMessage(input: unknown): GatewayServerMessage | null {
  let json: unknown
  try {
    json = JSON.parse(String(input))
  } catch {
    return null
  }

  const parsed = GatewayServerMessageSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

async function verifyRegistration(
  ceremonyId: string,
  response: RegistrationResponseJSON,
): Promise<AuthSession> {
  return AuthSessionSchema.parse(
    await postJson('/api/auth/register/verify', { ceremonyId, response }),
  )
}

async function verifyLogin(
  ceremonyId: string,
  response: AuthenticationResponseJSON,
  deviceName: string,
): Promise<AuthSession> {
  return AuthSessionSchema.parse(
    await postJson('/api/auth/login/verify', { ceremonyId, response, deviceName }),
  )
}

async function getJson(path: string, token?: string): Promise<unknown> {
  const res = await fetch(path, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(await errorMessageFromResponse(res, path))
  return res.json()
}

async function postJson(path: string, body: unknown, token?: string): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await errorMessageFromResponse(res, path))
  return res.json()
}

async function errorMessageFromResponse(res: Response, path: string): Promise<string> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = undefined
  }
  return errorMessageFromBody(res.status, path, body)
}

/**
 * Renders the daemon's error body into a message the user can act on, instead
 * of a bare status code. The daemon returns `{error: "<exact dead-end
 * command>"}` on 409 (`VaultUnavailableError`) and most 400/500s
 * (`OnboardingStepError`, the generic 500 fallback) -- Hermes discipline: dead
 * ends print the exact next command. Body-validation failures instead return
 * `{error: <zod issues array>}` (see e.g. `onboarding-routes.ts`,
 * `server.ts`): `error` there is an array of `{path, message}` objects, not a
 * string, so it is rendered the same compact "path: message; …" list a
 * top-level `issues` array would be. The top-level `issues` shape is kept for
 * defensiveness/forward-compatibility even though no current route emits it.
 * Falls back to the status code only when the body has none of these shapes.
 * Exported and pure so it can be table-tested without a network call.
 */
export function errorMessageFromBody(status: number, path: string, body: unknown): string {
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>
    if (typeof record['error'] === 'string' && record['error'].length > 0) {
      return record['error']
    }
    if (Array.isArray(record['error'])) {
      const rendered = renderZodIssues(record['error'])
      if (rendered.length > 0) return `${path} failed: ${rendered}`
    }
    if (Array.isArray(record['issues'])) {
      const rendered = renderZodIssues(record['issues'])
      if (rendered.length > 0) return `${path} failed: ${rendered}`
    }
  }
  return `${path} failed: ${status}`
}

function renderZodIssues(issues: unknown[]): string {
  return issues
    .map((issue) => renderZodIssue(issue))
    .filter((message) => message.length > 0)
    .join('; ')
}

function renderZodIssue(issue: unknown): string {
  if (issue === null || typeof issue !== 'object') return ''
  const record = issue as Record<string, unknown>
  const message = typeof record['message'] === 'string' ? record['message'] : ''
  if (message.length === 0) return ''
  const path = Array.isArray(record['path']) ? record['path'].join('.') : ''
  return path.length > 0 ? `${path}: ${message}` : message
}

/** Shared with push.ts so the push-subscription requests use the exact same
 * Bearer-token convention as every other /api call. */
export function authHeaders(token: string | undefined): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {}
}
