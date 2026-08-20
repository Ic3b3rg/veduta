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
  it('replays entrance, scopes update feedback, and previews both catalog themes', () => {
    const browser = installMotionBrowser(false)
    render(<MotionShowcasePage />)

    expect(screen.getByRole('heading', { name: 'Staggered entrance' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Region-scoped update' })).toBeDefined()
    expect(document.querySelectorAll('[data-veduta-theme="light"]')).toHaveLength(2)

    browser.calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Apply region update' }))
    expect(screen.getByText('Ready')).toBeDefined()
    expect(browser.calls.map(({ nodeId }) => nodeId)).toEqual(['motion-status'])

    browser.calls.length = 0
    fireEvent.click(screen.getByRole('button', { name: 'Replay entrance' }))
    expect(browser.calls.map(({ nodeId }) => nodeId)).toEqual([
      'motion-title',
      'motion-status',
      'motion-next-check',
      'motion-summary',
      'motion-progress',
      'motion-caption',
      'motion-root',
    ])

    browser.calls.length = 0
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.querySelectorAll('[data-veduta-theme="dark"]')).toHaveLength(2)
    expect(browser.animate).toHaveBeenCalledTimes(22)
    expect(browser.calls).toEqual([])
  })

  it('keeps both showcase actions motion-free with reduced motion', () => {
    const browser = installMotionBrowser(true)
    render(<MotionShowcasePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Replay entrance' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply region update' }))

    expect(screen.getByText('Ready')).toBeDefined()
    expect(browser.animate).not.toHaveBeenCalled()
  })
})
