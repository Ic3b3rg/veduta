/** Builds the canonical client path for a Surface, including legacy ids that are unsafe as URL segments. */
export function surfacePath(spaceSlug: string, surfaceId: string): string {
  const base = `/app/space/${encodeURIComponent(spaceSlug)}/surface/`
  try {
    const segment = encodeURIComponent(surfaceId)
    if (surfaceId !== '.' && surfaceId !== '..') return `${base}${segment}`
  } catch {
    // An arbitrary legacy Surface id can contain an unpaired UTF-16 code
    // unit. The query codec below preserves it without encodeURIComponent.
  }
  return `${base}_?surfaceIdUtf16=${encodeUtf16(surfaceId)}`
}

/** Decodes the exceptional route form emitted above; ordinary legacy paths pass through. */
export function surfaceIdFromRoute(
  routeSurfaceId: string | undefined,
  search: string,
): string | undefined {
  if (routeSurfaceId !== '_') return routeSurfaceId
  const encoded = new URLSearchParams(search).get('surfaceIdUtf16')
  if (encoded === null || encoded.length === 0 || !/^(?:[0-9a-f]{4})+$/i.test(encoded)) {
    return routeSurfaceId
  }
  let decoded = ''
  for (let index = 0; index < encoded.length; index += 4) {
    decoded += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 4), 16))
  }
  return decoded
}

function encodeUtf16(value: string): string {
  let encoded = ''
  for (let index = 0; index < value.length; index += 1) {
    encoded += value.charCodeAt(index).toString(16).padStart(4, '0')
  }
  return encoded
}
