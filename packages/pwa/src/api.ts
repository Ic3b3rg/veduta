import type { Space, Surface } from '@veduta/protocol'

export interface SpaceWithSurfaces extends Space {
  surfaces: Surface[]
}

export async function fetchSpaces(): Promise<SpaceWithSurfaces[]> {
  const res = await fetch('/api/spaces')
  if (!res.ok) throw new Error(`GET /api/spaces failed: ${res.status}`)
  const body = (await res.json()) as { spaces: SpaceWithSurfaces[] }
  return body.spaces
}

export async function invokeFastAction(
  surfaceId: string,
  nodeId: string,
  name: string,
  stateKey: string,
  value: unknown,
): Promise<Surface> {
  const res = await fetch(`/api/surfaces/${surfaceId}/actions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nodeId, name, payload: { stateKey, value } }),
  })
  if (!res.ok) throw new Error(`fast action failed: ${res.status}`)
  const body = (await res.json()) as { surface: Surface }
  return body.surface
}

/** Human-readable freshness, shown on every Surface (ADR-0005). */
export function freshnessLabel(updatedAt: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`
}
