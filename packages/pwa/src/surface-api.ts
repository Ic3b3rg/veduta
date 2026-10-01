import {
  ActionInvocationSchema,
  RenderableFastActionOutcomeSchema,
  MoveSurfaceResultSchema,
  RenderablePinSurfaceResultSchema,
  RenderableSurfaceSnapshotSchema,
  type ActionInvocation,
  type RenderableSurfaceSnapshot,
  type MoveSurfaceResult,
  type RenderablePinSurfaceResult,
  type SurfaceMoveDirection,
} from '@veduta/protocol'
import { z } from 'zod'
import { authHeaders, getJson, postJson } from './api-http.ts'

export type SpaceWithSurfaces = RenderableSurfaceSnapshot['spaces'][number]

const SurfaceActionResponseSchema = z.union([
  RenderableFastActionOutcomeSchema,
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
  const body = await postJson(
    `/api/surfaces/${encodeURIComponent(surfaceId)}/pin`,
    { pinned },
    token,
  )
  return RenderablePinSurfaceResultSchema.parse(body)
}

export async function moveSurface(
  spaceId: string,
  surfaceId: string,
  direction: SurfaceMoveDirection,
  token?: string,
): Promise<MoveSurfaceResult> {
  const body = await postJson(
    `/api/spaces/${encodeURIComponent(spaceId)}/surfaces/${encodeURIComponent(surfaceId)}/move`,
    { direction },
    token,
  )
  return MoveSurfaceResultSchema.parse(body)
}

export async function invokeSurfaceAction(
  surfaceId: string,
  invocation: ActionInvocation,
  token?: string,
): Promise<SurfaceActionResponse> {
  const body = await postJson(
    `/api/surfaces/${encodeURIComponent(surfaceId)}/actions`,
    ActionInvocationSchema.parse(invocation),
    token,
  )
  return SurfaceActionResponseSchema.parse(body)
}
