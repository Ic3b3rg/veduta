import { SurfaceSnapshotSchema, type SurfaceSnapshot } from '@veduta/protocol'

export interface SurfaceDeepLink {
  spaceSlug: string
  surfaceId: string
}

export function surfaceDeepLink(spaceSlug: string, surfaceId: string): string {
  return `/app/space/${encodeURIComponent(spaceSlug)}/surface/${encodeURIComponent(surfaceId)}`
}

export function parseSurfaceDeepLink(pathname: string): SurfaceDeepLink | undefined {
  const match = /^\/app\/space\/([^/]+)\/surface\/([^/]+)$/.exec(pathname)
  if (!match) return undefined
  return {
    spaceSlug: decodeURIComponent(match[1]!),
    surfaceId: decodeURIComponent(match[2]!),
  }
}

export function mergeSurfaceOrder(surfaceIds: string[], savedOrder: string[]): string[] {
  const known = new Set(surfaceIds)
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const id of savedOrder) {
    if (!known.has(id) || seen.has(id)) continue
    ordered.push(id)
    seen.add(id)
  }

  for (const id of surfaceIds) {
    if (seen.has(id)) continue
    ordered.push(id)
  }

  return ordered
}

export function moveSurfaceId(surfaceIds: string[], surfaceId: string, offset: -1 | 1): string[] {
  const index = surfaceIds.indexOf(surfaceId)
  const nextIndex = index + offset
  if (index < 0 || nextIndex < 0 || nextIndex >= surfaceIds.length) return surfaceIds

  const next = [...surfaceIds]
  const [removed] = next.splice(index, 1)
  next.splice(nextIndex, 0, removed!)
  return next
}

export function saveSnapshot(storage: Storage, key: string, snapshot: SurfaceSnapshot): void {
  storage.setItem(key, JSON.stringify(SurfaceSnapshotSchema.parse(snapshot)))
}

export function cachedSnapshot(storage: Storage, key: string): SurfaceSnapshot | undefined {
  const raw = storage.getItem(key)
  if (!raw) return undefined

  try {
    const parsed = SurfaceSnapshotSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}
