// @vitest-environment jsdom
import { AtomNodeSchema, type AtomNode } from '@veduta/protocol'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogTokens } from './design-system.ts'
import { renderNode } from './render.tsx'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PendingAtom', () => {
  it('renders every footprint as an accessible token-driven skeleton', () => {
    const startedAt = new Date().toISOString()
    const pendingTree = AtomNodeSchema.parse({
      id: 'pending-root',
      type: 'Box',
      children: [
        {
          id: 'pending-text',
          type: 'Pending',
          props: { variant: 'text', label: 'Trip summary', lines: 3, startedAt },
        },
        {
          id: 'pending-list',
          type: 'Pending',
          props: { variant: 'list', label: 'Packing list', rows: 4, startedAt },
        },
        {
          id: 'pending-image',
          type: 'Pending',
          props: { variant: 'image', label: 'Route preview', startedAt },
        },
        {
          id: 'pending-stat',
          type: 'Pending',
          props: { variant: 'stat', label: 'Trip distance', startedAt },
        },
        {
          id: 'pending-chart',
          type: 'Pending',
          props: { variant: 'chart', label: 'Daily distance', startedAt },
        },
      ],
    })

    const light = render(renderNode(pendingTree, { state: {}, dispatch: vi.fn(), theme: 'light' }))

    expect(screen.getByRole('status', { name: 'Trip summary loading' })).toBeDefined()
    expect(screen.getByRole('status', { name: 'Packing list loading' })).toBeDefined()
    expect(screen.getByRole('status', { name: 'Route preview loading' })).toBeDefined()
    expect(screen.getByRole('status', { name: 'Trip distance loading' })).toBeDefined()
    expect(screen.getByRole('status', { name: 'Daily distance loading' })).toBeDefined()

    const textSlot = pendingSlot(light.container, 'text')
    const listSlot = pendingSlot(light.container, 'list')
    const imageSlot = pendingSlot(light.container, 'image')
    const statSlot = pendingSlot(light.container, 'stat')
    const chartSlot = pendingSlot(light.container, 'chart')
    expect(textSlot.querySelectorAll('[data-pending-skeleton-line]')).toHaveLength(3)
    expect(listSlot.querySelectorAll('[data-pending-skeleton-row]')).toHaveLength(4)
    expect(imageSlot.style.aspectRatio).toBe('16 / 9')
    expect(statSlot.style.minWidth).toBe('96px')
    expect(chartSlot.style.minHeight).toBe('132px')

    const lightShape = textSlot.querySelector<HTMLElement>('[data-pending-skeleton-shape]')
    expect(lightShape?.style.background).toBe(cssColor(catalogTokens.light.color.surfaceMuted))

    light.unmount()
    const dark = render(renderNode(pendingTree, { state: {}, dispatch: vi.fn(), theme: 'dark' }))
    const darkShape = pendingSlot(dark.container, 'text').querySelector<HTMLElement>(
      '[data-pending-skeleton-shape]',
    )
    expect(darkShape?.style.background).toBe(cssColor(catalogTokens.dark.color.surfaceMuted))
  })

  it('degrades an unresolved slot at its composition-relative timeout', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:00:00.000Z'))
    const pending = AtomNodeSchema.parse({
      id: 'pending-weather',
      type: 'Pending',
      props: {
        variant: 'stat',
        label: 'Weather',
        timeoutMs: 1_000,
        startedAt: '2026-08-21T12:00:00.000Z',
      },
    })

    const firstMount = render(renderNode(pending, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByRole('status', { name: 'Weather loading' })).toBeDefined()

    act(() => vi.advanceTimersByTime(400))
    firstMount.unmount()
    vi.setSystemTime(new Date('2026-08-21T12:00:01.001Z'))

    render(renderNode(pending, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toBe('Weather unavailable')
    expect(screen.queryByRole('status', { name: 'Weather loading' })).toBeNull()
  })

  it('uses the remaining composition time rather than a fresh timeout after remount', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-21T12:00:00.750Z'))
    const pending = AtomNodeSchema.parse({
      id: 'pending-weather',
      type: 'Pending',
      props: {
        variant: 'stat',
        label: 'Weather',
        timeoutMs: 1_000,
        startedAt: '2026-08-21T12:00:00.000Z',
      },
    })

    render(renderNode(pending, { state: {}, dispatch: vi.fn() }))
    act(() => vi.advanceTimersByTime(249))
    expect(screen.queryByRole('alert')).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('alert').textContent).toBe('Weather unavailable')
  })

  it('renders malformed or unstamped data as a visible fallback', () => {
    const malformed: AtomNode = JSON.parse(
      '{"id":"pending-malformed","type":"Pending","props":{"variant":"video"}}',
    )
    const unstamped: AtomNode = JSON.parse(
      '{"id":"pending-unstamped","type":"Pending","props":{"variant":"text"}}',
    )

    const malformedView = render(renderNode(malformed, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toBe('Content unavailable')
    expect(screen.queryByTestId('unknown-atom')).toBeNull()

    malformedView.unmount()
    render(renderNode(unstamped, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByRole('alert').textContent).toBe('Content unavailable')
  })
})

function pendingSlot(container: HTMLElement, variant: string): HTMLElement {
  const slot = container.querySelector<HTMLElement>(`[data-pending-variant="${variant}"]`)
  if (!slot) throw new Error(`missing ${variant} Pending slot`)
  return slot
}

function cssColor(color: string): string {
  const element = document.createElement('div')
  element.style.background = color
  return element.style.background
}
