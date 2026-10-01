import {
  RenderableFastSurfaceActionResultSchema,
  MoveSurfaceResultSchema,
  RenderablePinSurfaceResultSchema,
  RenderableSurfaceSnapshotSchema,
  RenderableSurfaceSchema,
  type KnownRenderableAtomNode,
  type RenderableFastSurfaceActionResult,
  type JsonObject,
  type JsonValue,
  type RenderableSurface,
  type RenderableSurfaceSnapshot,
  type MoveSurfaceResult,
  type RenderablePinSurfaceResult,
  type SurfaceMoveDirection,
} from '@veduta/protocol'
import { z } from 'zod'
import { authHeaders, errorMessageFromBody, getJson, postJson } from './api-http.ts'

export type SpaceWithSurfaces = RenderableSurfaceSnapshot['spaces'][number]

const SurfaceActionResponseSchema = z.union([
  RenderableFastSurfaceActionResultSchema,
  z.object({ turn: z.object({ id: z.string().min(1) }).passthrough() }),
])

const SpaceAttentionSeenResponseSchema = z.object({
  count: z.number().int().min(0),
  revision: z.number().int().min(0),
})

export type SurfaceActionResponse = z.infer<typeof SurfaceActionResponseSchema>

export async function fetchSpaces(token?: string): Promise<RenderableSurfaceSnapshot> {
  return RenderableSurfaceSnapshotSchema.parse(await getJson('/api/spaces', token))
}

export async function markSpaceAttentionSeen(
  spaceId: string,
  token?: string,
): Promise<{ count: number; revision: number }> {
  const response = await fetch(`/api/spaces/${encodeURIComponent(spaceId)}/attention/seen`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  if (!response.ok) {
    throw new Error(`POST /api/spaces/${spaceId}/attention/seen failed: ${response.status}`)
  }
  return SpaceAttentionSeenResponseSchema.parse(await response.json())
}

/** Toggles a pinnable Surface. */
export async function pinSurface(
  surfaceId: string,
  pinned: boolean,
  token?: string,
): Promise<RenderablePinSurfaceResult> {
  const body = await postJson(`/api/surfaces/${surfaceId}/pin`, { pinned }, token)
  return RenderablePinSurfaceResultSchema.parse(body)
}

export async function moveSurface(
  spaceId: string,
  surfaceId: string,
  direction: SurfaceMoveDirection,
  token?: string,
): Promise<MoveSurfaceResult> {
  const body = await postJson(
    `/api/spaces/${spaceId}/surfaces/${surfaceId}/move`,
    { direction },
    token,
  )
  return MoveSurfaceResultSchema.parse(body)
}

export async function invokeFastAction(
  surfaceId: string,
  nodeId: string,
  name: string,
  value: JsonValue,
  token?: string,
  idempotencyKey?: string,
): Promise<RenderableFastSurfaceActionResult> {
  const result = await invokeSurfaceAction(
    surfaceId,
    nodeId,
    name,
    { value },
    token,
    idempotencyKey,
  )
  if ('surface' in result) return result
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
  const response = await fetch(`/api/surfaces/${surfaceId}/actions`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId,
      name,
      ...(payload === undefined ? {} : { payload }),
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    }),
  })
  if (!response.ok) {
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = undefined
    }
    throw new Error(
      errorMessageFromBody(response.status, `/api/surfaces/${surfaceId}/actions`, body),
    )
  }
  return SurfaceActionResponseSchema.parse(await response.json())
}

export function optimisticFastSurface(
  surface: RenderableSurface,
  node: KnownRenderableAtomNode,
  actionName: string,
  value: JsonValue,
  updatedAt = new Date().toISOString(),
): RenderableSurface {
  const action = node.actions?.find((candidate) => candidate.name === actionName)
  if (action?.path !== 'fast' || action.stateKey === undefined) return surface

  return RenderableSurfaceSchema.parse({
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
