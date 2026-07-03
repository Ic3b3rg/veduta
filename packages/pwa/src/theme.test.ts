import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { preferredTheme, subscribeToThemeChanges } from './theme.ts'

function stubMatchMedia(matches: boolean) {
  const listeners: Array<() => void> = []
  // Like real browsers, return a fresh MediaQueryList per matchMedia call.
  const matchMedia = () =>
    fromPartial<MediaQueryList>({
      matches,
      addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: () => void) => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      },
    })
  vi.stubGlobal('window', fromPartial<Window>({ matchMedia }))
  return listeners
}

afterEach(() => vi.unstubAllGlobals())

describe('preferredTheme', () => {
  it('returns dark when the device prefers a dark color scheme', () => {
    stubMatchMedia(true)
    expect(preferredTheme()).toBe('dark')
  })

  it('returns light otherwise', () => {
    stubMatchMedia(false)
    expect(preferredTheme()).toBe('light')
  })
})

describe('subscribeToThemeChanges', () => {
  it('registers a change listener and unregisters it on cleanup', () => {
    const listeners = stubMatchMedia(false)
    const onChange = vi.fn()
    const unsubscribe = subscribeToThemeChanges(onChange)
    expect(listeners).toHaveLength(1)
    unsubscribe()
    expect(listeners).toHaveLength(0)
  })
})
