// @vitest-environment jsdom
import { SurfaceSchema } from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurfaceCard } from './surface-card.tsx'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-20T21:59:59.000Z'))
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('SurfaceCard relative-time validity', () => {
  it('shows the legacy-data caveat and visibly expires at the declared boundary without a new event', () => {
    render(
      <SurfaceCard
        surface={relativeSurface()}
        selected={false}
        canMoveUp={false}
        canMoveDown={false}
        onFocus={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onPatched={vi.fn()}
        onQueueFastAction={vi.fn()}
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
        onError={vi.fn()}
      />,
    )

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('note').textContent).toContain(
      '1 source record has no occurrence date and is excluded from this relative-time view.',
    )

    act(() => vi.advanceTimersByTime(1_000))

    expect(screen.getByRole('status').textContent).toContain(
      'This relative-time view expired. Values below are preserved but are not current.',
    )
    expect(screen.getByText('Bookshop')).toBeDefined()
  })
})

describe('SurfaceCard material hierarchy', () => {
  it('embeds Atom content inside one pinnable Surface shell', () => {
    const surface = SurfaceSchema.parse({
      ...relativeSurface(),
      pinned: true,
      pinnable: true,
    })
    const { container } = render(
      <SurfaceCard
        surface={surface}
        selected={true}
        canMoveUp={false}
        canMoveDown={false}
        onFocus={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        onPatched={vi.fn()}
        onQueueFastAction={vi.fn()}
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
        onError={vi.fn()}
      />,
    )

    const card = container.querySelector('article.surface-card')
    expect(card?.classList.contains('pinned')).toBe(true)

    const content = card?.querySelector(':scope > .surface-content')
    expect(content).not.toBeNull()
    expect(content?.querySelector(':scope > [data-veduta-theme="light"]')).not.toBeNull()
  })
})

describe('SurfaceCard Form submission', () => {
  it('does not mutate while typing and sends one complete atomic payload', async () => {
    vi.useRealTimers()
    const initial = formSurface()
    const updated = SurfaceSchema.parse({
      ...initial,
      state: { displayName: 'Grace', bio: 'Compiler pioneer' },
      freshness: { updatedAt: '2026-09-01T08:01:00.000Z', updatedBy: 'user' },
    })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _request?: RequestInit) =>
      Promise.resolve(
        new Response(JSON.stringify({ surface: updated, surfaceCursor: 7 }), { status: 200 }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onPatched = vi.fn()
    const onQueueFastAction = vi.fn()
    render(<SurfaceCard {...surfaceCardProps(initial, { onPatched, onQueueFastAction })} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Grace' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Biography' }), {
      target: { value: 'Compiler pioneer' },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(onPatched).not.toHaveBeenCalled()
    expect(initial.state).toEqual({ displayName: 'Ada', bio: 'First programmer' })

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [, request] = fetchMock.mock.calls[0] ?? []
    const body = JSON.parse(String(request?.body))
    expect(body).toMatchObject({
      nodeId: 'profile-form',
      name: 'submit',
      payload: { value: { displayName: 'Grace', bio: 'Compiler pioneer' } },
    })
    expect(body.idempotencyKey).toMatch(/^fast-/)
    await waitFor(() => expect(onPatched).toHaveBeenCalledWith(updated, expect.any(Array), 7))
    expect(onQueueFastAction).not.toHaveBeenCalled()
  })

  it('keeps the draft visible and retries with the same idempotency key after failure', async () => {
    vi.useRealTimers()
    const initial = formSurface()
    const updated = SurfaceSchema.parse({
      ...initial,
      state: { ...initial.state, displayName: 'Grace' },
      freshness: { updatedAt: '2026-09-01T08:01:00.000Z', updatedBy: 'user' },
    })
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'The Form could not be saved.' }), { status: 503 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ surface: updated, surfaceCursor: 8 }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const onQueueFastAction = vi.fn()
    const view = render(<SurfaceCard {...surfaceCardProps(initial, { onQueueFastAction })} />)
    const name = screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    expect((await screen.findByRole('alert')).textContent).toBe('The Form could not be saved.')
    expect(name.value).toBe('Grace')
    expect(onQueueFastAction).not.toHaveBeenCalled()

    view.rerender(
      <SurfaceCard
        {...surfaceCardProps(
          SurfaceSchema.parse({
            ...initial,
            freshness: { updatedAt: '2026-09-01T08:00:30.000Z', updatedBy: 'agent' },
          }),
          { onQueueFastAction },
        )}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    const requestBodies = fetchMock.mock.calls.map(([, request]) =>
      JSON.parse(String(request?.body)),
    )
    expect(requestBodies[0]?.idempotencyKey).toBe(requestBodies[1]?.idempotencyKey)
    expect(requestBodies[1]?.payload).toEqual({
      value: { displayName: 'Grace', bio: 'First programmer' },
    })
  })

  it('starts a new idempotency cycle after a different draft succeeds', async () => {
    vi.useRealTimers()
    const initial = formSurface()
    const surfaceFor = (displayName: string, minute: number) =>
      SurfaceSchema.parse({
        ...initial,
        state: { ...initial.state, displayName },
        freshness: {
          updatedAt: `2026-09-01T08:0${minute}:00.000Z`,
          updatedBy: 'user',
        },
      })
    const katherine = surfaceFor('Katherine', 2)
    const grace = surfaceFor('Grace', 3)
    const responseFor = (surface: ReturnType<typeof surfaceFor>, surfaceCursor: number) =>
      new Response(JSON.stringify({ surface, surfaceCursor }), { status: 200 })
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Try again.' }), { status: 503 }))
      .mockResolvedValueOnce(responseFor(katherine, 2))
      .mockResolvedValueOnce(responseFor(grace, 3))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<SurfaceCard {...surfaceCardProps(initial)} />)
    const name = screen.getByRole('textbox', { name: 'Display name' })
    const save = screen.getByRole('button', { name: 'Save profile' })

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(save)
    expect((await screen.findByRole('alert')).textContent).toBe('Try again.')

    fireEvent.change(name, { target: { value: 'Katherine' } })
    fireEvent.click(save)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    view.rerender(<SurfaceCard {...surfaceCardProps(katherine)} />)

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(save)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    const requestBodies = fetchMock.mock.calls.map(([, request]) =>
      JSON.parse(String(request?.body)),
    )
    expect(requestBodies[0]?.idempotencyKey).not.toBe(requestBodies[2]?.idempotencyKey)
  })
})

function relativeSurface() {
  return SurfaceSchema.parse({
    id: 'srf-daily-spending',
    spaceId: 'spc-finance',
    title: 'Daily spending',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'rows',
          type: 'Table',
          binding: 'todayRows',
          props: { columns: ['merchant', 'amount'] },
        },
      ],
    },
    state: {
      records: [
        { occurredAt: '2026-08-20T12:00:00+02:00', merchant: 'Bookshop', amount: 18 },
        { occurredAt: null, merchant: 'Legacy shop', amount: 7 },
      ],
      todayRows: [{ merchant: 'Bookshop', amount: 18 }],
    },
    freshness: { updatedAt: '2026-08-20T12:00:00.000Z', updatedBy: 'agent' },
    validity: {
      kind: 'relative-time',
      timeZone: 'Europe/Rome',
      window: 'day',
      startsAt: '2026-08-19T22:00:00.000Z',
      expiresAt: '2026-08-20T22:00:00.000Z',
      source: { stateKey: 'records' },
      projectionStateKeys: ['todayRows'],
    },
  })
}

function formSurface() {
  return SurfaceSchema.parse({
    id: 'srf-profile',
    spaceId: 'spc-health',
    title: 'Profile',
    tree: {
      id: 'profile-form',
      type: 'Form',
      props: { label: 'Profile details', submitLabel: 'Save profile' },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['displayName', 'bio'] }],
      children: [
        {
          id: 'display-name',
          type: 'Input',
          binding: 'displayName',
          props: { label: 'Display name' },
        },
        { id: 'bio', type: 'Textarea', binding: 'bio', props: { label: 'Biography' } },
      ],
    },
    state: { displayName: 'Ada', bio: 'First programmer' },
    freshness: { updatedAt: '2026-09-01T08:00:00.000Z', updatedBy: 'agent' },
  })
}

function surfaceCardProps(
  surface: ReturnType<typeof formSurface>,
  overrides: Partial<ComponentProps<typeof SurfaceCard>> = {},
): ComponentProps<typeof SurfaceCard> {
  return {
    surface,
    selected: false,
    canMoveUp: false,
    canMoveDown: false,
    onFocus: vi.fn(),
    onMoveUp: vi.fn(),
    onMoveDown: vi.fn(),
    onPatched: vi.fn(),
    onQueueFastAction: vi.fn(),
    onTogglePin: vi.fn(),
    onRevealFeedbackShown: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  }
}
