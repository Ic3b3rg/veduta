import { describe, expect, it } from 'vitest'
import { surfaceIdFromRoute, surfacePath } from './surface-route.ts'

describe('Surface route codec', () => {
  it('encodes ordinary Space and Surface path segments', () => {
    expect(surfacePath('weekly review', 'srf/plan')).toBe(
      '/app/space/weekly%20review/surface/srf%2Fplan',
    )
  })

  it('round-trips dot segments without browser path normalization', () => {
    const path = surfacePath('health', '..')
    expect(path).toBe('/app/space/health/surface/_?surfaceIdUtf16=002e002e')
    expect(surfaceIdFromRoute('_', new URL(path, 'http://localhost').search)).toBe('..')
  })

  it('round-trips a legacy id containing an unpaired UTF-16 code unit', () => {
    const surfaceId = '\ud800'
    const path = surfacePath('health', surfaceId)
    expect(surfaceIdFromRoute('_', new URL(path, 'http://localhost').search)).toBe(surfaceId)
  })

  it('leaves malformed exceptional routes on their literal Surface id', () => {
    expect(surfaceIdFromRoute('_', '?surfaceIdUtf16=not-hex')).toBe('_')
  })
})
