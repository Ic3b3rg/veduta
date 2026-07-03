import {
  AuthSessionSchema,
  AuthStatusSchema,
  GatewayServerMessageSchema,
  SurfaceSnapshotSchema,
  SurfaceSchema,
  WebAuthnOptionsEnvelopeSchema,
  type AtomNode,
  type AuthSession,
  type AuthStatus,
  type GatewayServerMessage,
  type JsonObject,
  type JsonValue,
  type Surface,
  type SurfacePatchEvent,
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
const SpacesResponseSchema = SurfaceSnapshotSchema

export type SpaceWithSurfaces = z.infer<typeof SpacesResponseSchema>['spaces'][number]
export type SpacesSnapshot = z.infer<typeof SpacesResponseSchema>

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
  surfaceCursor: number
  onHello(cursor: number): void
  onSurfacePatch(event: SurfacePatchEvent): void
  onChatMessage(message: Extract<GatewayServerMessage, { type: 'chat.message' }>): void
  onApprovalCard(message: Extract<GatewayServerMessage, { type: 'approval.card' }>): void
  onPresence(message: Extract<GatewayServerMessage, { type: 'presence.update' }>): void
  onError(message: string): void
  onClose(): void
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const res = await fetch('/api/auth/status')
  if (!res.ok) throw new Error(`GET /api/auth/status failed: ${res.status}`)
  return AuthStatusSchema.parse(await res.json())
}

export async function fetchSpaces(token?: string): Promise<SpacesSnapshot> {
  const res = await fetch('/api/spaces', { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`GET /api/spaces failed: ${res.status}`)
  return SpacesResponseSchema.parse(await res.json())
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
      }),
    )
  }

  ws.onmessage = (event) => {
    const message = parseGatewayMessage(event.data)
    if (!message) return

    if (message.type === 'hello') {
      handlers.onHello(message.surfaceCursor)
      return
    }

    if (message.type === 'surface.patch') {
      handlers.onSurfacePatch(message.event)
      return
    }

    if (message.type === 'chat.message') {
      handlers.onChatMessage(message)
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

async function postJson(path: string, body: unknown, token?: string): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

function authHeaders(token: string | undefined): HeadersInit {
  return token ? { authorization: `Bearer ${token}` } : {}
}
