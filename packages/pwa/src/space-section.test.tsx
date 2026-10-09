// @vitest-environment jsdom
import { render, screen, fireEvent, within } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { SpaceSection } from './space-section.tsx'
import { appTestSurface, installAppTestBrowser, resetAppTestBrowser } from './app-test-support.ts'

beforeEach(() => {
  installAppTestBrowser()
})
afterEach(resetAppTestBrowser)

function props(surfaces: ComponentProps<typeof SpaceSection>['space']['surfaces']) {
  return {
    space: {
      id: 'spc-health',
      slug: 'health',
      name: 'Health',
      archived: false,
      attention: 0,
      attentionRevision: 0,
      surfaces,
    },
    focused: true,
    focusedSurfaceId: undefined,
    surfaceRevealFeedbackKeys: {},
    surfaceUpdateFeedbacks: {},
    onFocus: vi.fn(),
    onMoveSurface: vi.fn(),
    onTogglePin: vi.fn(),
    onSurfaceRevealFeedbackShown: vi.fn(),
  }
}

describe('Space Surface groups', () => {
  it('labels non-empty groups and preserves their Gateway order with local Move boundaries', () => {
    const surfaces = [
      { ...appTestSurface('srf-z', 'Z pinned'), pinned: true },
      { ...appTestSurface('srf-a', 'A pinned'), pinned: true },
      appTestSurface('srf-y', 'Y regular'),
      { ...appTestSurface('srf-b', 'B managed'), pinnable: false },
    ]
    const handlers = props(surfaces)
    render(<SpaceSection {...handlers} />)
    expect(screen.getByRole('heading', { name: 'Pinned (2)', level: 3 })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Surfaces (2)', level: 3 })).toBeDefined()
    expect(
      screen.getAllByRole('button', { name: /^Focus / }).map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Focus Z pinned', 'Focus A pinned', 'Focus Y regular', 'Focus B managed'])
    for (const title of ['Z pinned', 'Y regular']) {
      expect(
        screen.getByRole('button', { name: `Move ${title} up` }).getAttribute('aria-disabled'),
      ).toBe('true')
      expect(
        screen.getByRole('button', { name: `Move ${title} down` }).getAttribute('aria-disabled'),
      ).toBe('false')
    }
    for (const title of ['A pinned', 'B managed']) {
      expect(
        screen.getByRole('button', { name: `Move ${title} down` }).getAttribute('aria-disabled'),
      ).toBe('true')
      expect(
        screen.getByRole('button', { name: `Move ${title} up` }).getAttribute('aria-disabled'),
      ).toBe('false')
    }
    fireEvent.click(screen.getByRole('button', { name: 'Move Z pinned down' }))
    expect(handlers.onMoveSurface).toHaveBeenCalledWith(handlers.space, 'srf-z', 'down')
    expect(screen.queryByRole('button', { name: /Pin B managed/ })).toBeNull()
    expect(screen.queryByText('no Surfaces')).toBeNull()
  })

  it.each([true, false])('renders only the populated group when pinned=%s', (pinned) => {
    render(<SpaceSection {...props([{ ...appTestSurface('srf-only', 'Only'), pinned }])} />)
    expect(
      screen.getByRole('heading', { name: `${pinned ? 'Pinned' : 'Surfaces'} (1)`, level: 3 }),
    ).toBeDefined()
    expect(
      screen.queryByRole('heading', { name: pinned ? /^Surfaces \(/ : /^Pinned \(/ }),
    ).toBeNull()
    expect(screen.getAllByRole('article')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Move Only up' }).getAttribute('aria-disabled')).toBe(
      'true',
    )
    expect(
      screen.getByRole('button', { name: 'Move Only down' }).getAttribute('aria-disabled'),
    ).toBe('true')
    expect(screen.queryByText('no Surfaces')).toBeNull()
  })

  it('shows no Surfaces only for an empty Space and derives other Space counts independently', () => {
    const other = props([
      { ...appTestSurface('srf-other', 'Other'), spaceId: 'spc-work', pinned: true },
    ])
    render(
      <>
        <SpaceSection {...props([])} />
        <SpaceSection
          {...other}
          space={{ ...other.space, id: 'spc-work', slug: 'work', name: 'Work' }}
        />
      </>,
    )
    const health = within(screen.getByRole('region', { name: 'Health' }))
    expect(health.getByText('no Surfaces')).toBeDefined()
    expect(health.queryAllByRole('article')).toHaveLength(0)
    expect(health.queryAllByRole('heading', { level: 3 })).toHaveLength(0)
    const work = within(screen.getByRole('region', { name: 'Work' }))
    expect(work.getByRole('heading', { name: 'Pinned (1)' })).toBeDefined()
    expect(work.queryByText('no Surfaces')).toBeNull()
  })

  it.each(['group-pinned', 'group-regular'])(
    'preserves the focused control through Pin and Unpin for Surface %s',
    (id) => {
      const item = appTestSurface(id, 'Moving')
      const other = appTestSurface('srf-other', 'Other')
      const handlers = props([other, item])
      const { rerender } = render(<SpaceSection {...handlers} />)
      const button = screen.getByRole('button', { name: 'Pin Moving' })
      button.focus()
      rerender(
        <SpaceSection
          {...handlers}
          space={{ ...handlers.space, surfaces: [{ ...item, pinned: true }, other] }}
        />,
      )
      expect(screen.getByRole('button', { name: 'Pinned Moving' })).toBe(button)
      expect(document.activeElement).toBe(button)
      expect(screen.getByRole('heading', { name: 'Pinned (1)' })).toBeDefined()
      expect(screen.getByRole('heading', { name: 'Surfaces (1)' })).toBeDefined()
      rerender(
        <SpaceSection {...handlers} space={{ ...handlers.space, surfaces: [item, other] }} />,
      )
      expect(screen.getAllByRole('article')).toHaveLength(2)
      expect(screen.getByRole('button', { name: 'Pin Moving' })).toBe(button)
      expect(document.activeElement).toBe(button)
    },
  )

  it('keeps valid epoch freshness distinct from an empty Space', () => {
    const item = appTestSurface('srf-epoch', 'Legacy')
    render(
      <SpaceSection
        {...props([
          { ...item, freshness: { ...item.freshness, updatedAt: '1970-01-01T00:00:00.000Z' } },
        ])}
      />,
    )
    expect(screen.queryByText('no Surfaces')).toBeNull()
    expect(screen.getByText(/^freshest /)).toBeDefined()
  })
})
