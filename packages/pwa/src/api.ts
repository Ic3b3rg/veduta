import { SpaceSchema, SurfaceSchema, type Surface } from '@veduta/protocol'
import { z } from 'zod'

// The PWA never trusts the wire blindly (AGENTS.md): every response is
// validated with the protocol schemas before it reaches a component.
const SpacesResponseSchema = z.object({
  spaces: z.array(SpaceSchema.extend({ surfaces: z.array(SurfaceSchema) })),
})

export type SpaceWithSurfaces = z.infer<typeof SpacesResponseSchema>['spaces'][number]

const ActionResponseSchema = z.object({ surface: SurfaceSchema })

export async function fetchSpaces(): Promise<SpaceWithSurfaces[]> {
  const res = await fetch('/api/spaces')
  if (!res.ok) throw new Error(`GET /api/spaces failed: ${res.status}`)
  return SpacesResponseSchema.parse(await res.json()).spaces
}

export async function invokeFastAction(
  surfaceId: string,
  nodeId: string,
  name: string,
  value: unknown,
): Promise<Surface> {
  const res = await fetch(`/api/surfaces/${surfaceId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, name, payload: { value } }),
  })
  if (!res.ok) throw new Error(`fast action failed: ${res.status}`)
  return ActionResponseSchema.parse(await res.json()).surface
}

/** Human-readable freshness, shown on every Surface (ADR-0005). */
export function freshnessLabel(updatedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
