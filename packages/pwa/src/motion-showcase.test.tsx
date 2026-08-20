// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { MotionShowcasePage } from './motion-showcase.tsx'
import { installMotionBrowser, restoreMotionBrowser } from './motion-test-browser.ts'

afterEach(() => {
  cleanup()
  restoreMotionBrowser()
})

describe('MotionShowcasePage', () => {
  it('replays entrance, scopes representative content updates, and previews both themes', () => {
    const browser = installMotionBrowser(false)
    render(<MotionShowcasePage />)

    expect(screen.getByRole('heading', { name: 'Staggered entrance' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Region-scoped update' })).toBeDefined()
    expect(document.querySelectorAll('[data-veduta-theme="light"]')).toHaveLength(2)

    browser.calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Apply region update' }))
    expect(screen.getAllByText('Ready')).toHaveLength(2)
    expect(screen.getByText('Review update')).toBeDefined()
    expect(
      screen
        .getAllByRole<HTMLInputElement>('checkbox', { name: 'Acknowledge update' })
        .map(({ checked }) => checked),
    ).toEqual([false, true])

    const contentFades = browser.calls.filter(({ keyframes }) => hasOpacityKeyframe(keyframes))
    expect(contentFades).toHaveLength(6)
    expect(contentFades.map(({ nodeId, contentKey }) => ({ nodeId, contentKey }))).toEqual(
      expect.arrayContaining([
        { nodeId: 'motion-status', contentKey: 'value' },
        { nodeId: 'motion-progress', contentKey: 'value' },
        { nodeId: 'motion-progress', contentKey: 'bar' },
        { nodeId: 'motion-activity', contentKey: expect.stringMatching(/^row:/) },
        { nodeId: 'motion-acknowledged', contentKey: 'value' },
        { nodeId: 'motion-transition', contentKey: 'content' },
      ]),
    )
    expect(
      browser.calls
        .filter(({ keyframes }) => !hasOpacityKeyframe(keyframes))
        .map(({ nodeId }) => nodeId),
    ).toEqual([
      'motion-status',
      'motion-progress',
      'motion-activity',
      'motion-acknowledged',
      'motion-transition',
    ])
    expect(browser.calls.some(({ nodeId }) => nodeId === 'motion-next-check')).toBe(false)
    expect(browser.calls.some(({ nodeId }) => nodeId === 'motion-transition-copy')).toBe(false)

    browser.calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Replay entrance' }))
    expect(new Set(browser.calls.map(({ nodeId }) => nodeId))).toEqual(
      new Set([
        'motion-title',
        'motion-status',
        'motion-next-check',
        'motion-summary',
        'motion-progress',
        'motion-activity',
        'motion-acknowledged',
        'motion-transition-copy',
        'motion-transition',
        'motion-caption',
        'motion-root',
      ]),
    )

    browser.calls.length = 0
    const animationsBeforeThemeChange = browser.animate.mock.calls.length
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.querySelectorAll('[data-veduta-theme="dark"]')).toHaveLength(2)
    expect(browser.animate).toHaveBeenCalledTimes(animationsBeforeThemeChange)
    expect(browser.calls).toEqual([])
  })

  it('keeps both showcase actions motion-free with reduced motion', () => {
    const browser = installMotionBrowser(true)
    render(<MotionShowcasePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Replay entrance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply region update' }))

    expect(screen.getAllByText('Ready')).toHaveLength(2)
    expect(browser.animate).not.toHaveBeenCalled()
  })
})

function hasOpacityKeyframe(keyframes: Keyframe[] | PropertyIndexedKeyframes): boolean {
  return Array.isArray(keyframes) && keyframes.some(({ opacity }) => opacity !== undefined)
}
