import { describe, expect, it } from 'vitest'
import { compareVersions, resolveInstalledVersion, VEDUTA_VERSION } from './version.ts'

describe('VEDUTA_VERSION', () => {
  it('is the dev placeholder the release build stamps over', () => {
    expect(VEDUTA_VERSION).toBe('0.0.0-dev')
  })
})

describe('resolveInstalledVersion', () => {
  it('resolves an unstamped build to the comparable 0.0.0 baseline, so the first release is discoverable', () => {
    expect(resolveInstalledVersion({})).toBe('0.0.0')
    expect(compareVersions('0.0.1', resolveInstalledVersion({}))).toBe(1)
  })

  it('lets the override stand in for the baseline', () => {
    expect(resolveInstalledVersion({ VEDUTA_INSTALLED_VERSION: '1.2.3' })).toBe('1.2.3')
  })

  it('ignores an override that is not an x.y.z triple', () => {
    expect(resolveInstalledVersion({ VEDUTA_INSTALLED_VERSION: 'nonsense' })).toBe('0.0.0')
    expect(resolveInstalledVersion({ VEDUTA_INSTALLED_VERSION: '' })).toBe('0.0.0')
  })
})

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('is tolerant of a leading v on either side', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3', 'v1.2.3')).toBe(0)
    expect(compareVersions('v1.2.3', 'v1.2.4')).toBe(-1)
  })

  it('compares by major first', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.9.9', '2.0.0')).toBe(-1)
  })

  it('compares by minor when major is equal', () => {
    expect(compareVersions('1.3.0', '1.2.9')).toBe(1)
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1)
  })

  it('compares by patch when major and minor are equal', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1)
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1)
  })

  it('throws on a non x.y.z string', () => {
    expect(() => compareVersions('1.2', '1.2.3')).toThrow(/is not an x\.y\.z version/)
    expect(() => compareVersions('1.2.3-rc1', '1.2.3')).toThrow(/is not an x\.y\.z version/)
  })
})
