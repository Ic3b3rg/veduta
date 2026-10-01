// @vitest-environment jsdom
import {
  AUTOMATION_OUTCOMES_STATE_KEY,
  FastActionInvocationSchema,
  SurfaceSchema,
  formSetPlan,
} from '@veduta/protocol'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SurfaceCard } from './surface-card.tsx'
import * as api from './api.ts'
import { createPwaLiveStateRuntime, type PwaLiveStateRuntime } from './pwa-live-state-runtime.ts'
import { PwaRuntimeContext } from './use-live-state.ts'
import { committedActionOutcome } from './action-test-support.ts'

const runtimes: PwaLiveStateRuntime[] = []

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
  for (const runtime of runtimes.splice(0)) runtime.stop()
  localStorage.clear()
  vi.unstubAllGlobals()
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
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
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
  it('renders full presentation independently of Pin and Atom content', () => {
    const props = surfaceCardProps(formSurface())
    const { container, rerender } = render(<SurfaceCard {...props} />)
    expect(
      container.querySelector('article')?.classList.contains('surface-presentation-full'),
    ).toBe(false)
    rerender(<SurfaceCard {...props} surface={{ ...props.surface, presentation: 'full' }} />)
    expect(
      container.querySelector('article')?.classList.contains('surface-presentation-full'),
    ).toBe(true)
    expect(screen.getByRole('button', { name: 'Pin Profile' }).getAttribute('aria-pressed')).toBe(
      'false',
    )
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveProperty('value', 'Ada')
  })

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
        onTogglePin={vi.fn()}
        onRevealFeedbackShown={vi.fn()}
      />,
    )

    const card = container.querySelector('article.surface-card')
    expect(card?.classList.contains('pinned')).toBe(true)

    const content = card?.querySelector(':scope > .surface-content')
    expect(content).not.toBeNull()
    expect(content?.querySelector(':scope > [data-veduta-theme="light"]')).not.toBeNull()
  })
})

describe('SurfaceCard automation outcome status', () => {
  it('keeps the latest run status visible on the linked Surface', () => {
    const surface = SurfaceSchema.parse({
      ...formSurface(),
      state: {
        displayName: 'Ada',
        bio: 'First programmer',
        [AUTOMATION_OUTCOMES_STATE_KEY]: {
          '7': {
            automationId: 7,
            latest: { kind: 'failed', summary: 'Calendar provider did not respond.' },
            lastCheckedAt: '2026-09-02T16:30:00.000Z',
            lastSuccessfulAt: '2026-09-02T08:30:00.000Z',
            currentError: { code: 'provider_timeout', message: 'Timed out after 30 seconds.' },
          },
        },
      },
    })

    render(<SurfaceCard {...surfaceCardProps(surface)} />)

    const status = screen.getByRole('region', { name: 'Automation 7 status' })
    expect(status.textContent).toContain('Failed')
    expect(status.textContent).toContain('Calendar provider did not respond.')
    expect(status.textContent).toContain('Timed out after 30 seconds.')
    expect(status.querySelector('time[datetime="2026-09-02T16:30:00.000Z"]')).not.toBeNull()
    expect(status.querySelector('time[datetime="2026-09-02T08:30:00.000Z"]')).not.toBeNull()
    expect(screen.getByRole('textbox', { name: 'Display name' })).toBeDefined()
  })

  it('keeps independent statuses visible when Automations share a Surface', () => {
    const surface = SurfaceSchema.parse({
      ...formSurface(),
      state: {
        displayName: 'Ada',
        bio: 'First programmer',
        [AUTOMATION_OUTCOMES_STATE_KEY]: {
          '7': {
            automationId: 7,
            latest: { kind: 'recovered', summary: 'Calendar is reachable again.' },
            lastCheckedAt: '2026-09-02T16:30:00.000Z',
            lastSuccessfulAt: '2026-09-02T16:30:00.000Z',
          },
          '8': {
            automationId: 8,
            latest: { kind: 'failed', summary: 'Tasks provider did not respond.' },
            lastCheckedAt: '2026-09-02T16:31:00.000Z',
            currentError: { code: 'provider_timeout', message: 'Tasks timed out.' },
          },
        },
      },
    })

    render(<SurfaceCard {...surfaceCardProps(surface)} />)

    expect(screen.getByRole('region', { name: 'Automation 7 status' }).textContent).toContain(
      'Calendar is reachable again.',
    )
    expect(screen.getByRole('region', { name: 'Automation 8 status' }).textContent).toContain(
      'Tasks timed out.',
    )
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
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, request?: RequestInit) =>
        new Response(
          JSON.stringify(
            committedActionOutcome(
              FastActionInvocationSchema.parse(JSON.parse(String(request?.body))),
              updated,
              {
                surfaceId: initial.id,
                operations: [
                  { target: 'state', op: 'replace', path: '/displayName', value: 'Grace' },
                  { target: 'state', op: 'replace', path: '/bio', value: 'Compiler pioneer' },
                ],
              },
              7,
            ),
          ),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const runtime = await cardRuntime(initial)
    render(<RuntimeCard runtime={runtime} {...surfaceCardProps(initial)} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Grace' },
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'Biography' }), {
      target: { value: 'Compiler pioneer' },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]).toEqual(initial)
    expect(initial.state).toEqual({ displayName: 'Ada', bio: 'First programmer' })

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const [, request] = fetchMock.mock.calls[0] ?? []
    const body = JSON.parse(String(request?.body))
    expect(body).toMatchObject({
      nodeId: 'profile-form',
      name: 'submit',
      inputs: { displayName: 'Grace', bio: 'Compiler pioneer' },
      actionRevision: 'acr-profile',
    })
    expect(FastActionInvocationSchema.parse(body).intentId).toEqual(expect.any(String))
    await waitFor(() => expect(runtime.getSnapshot().spaces[0]?.surfaces[0]).toEqual(updated))
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
  })

  it('keeps the draft and retries a retryable failure with the same stable intent', async () => {
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
      .mockImplementationOnce(
        async (_input, request) =>
          new Response(
            JSON.stringify(
              committedActionOutcome(
                FastActionInvocationSchema.parse(JSON.parse(String(request?.body))),
                updated,
                {
                  surfaceId: initial.id,
                  operations: [
                    { target: 'state', op: 'replace', path: '/displayName', value: 'Grace' },
                  ],
                },
                8,
              ),
            ),
            { status: 200 },
          ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const runtime = await cardRuntime(initial)
    const view = render(<RuntimeCard runtime={runtime} {...surfaceCardProps(initial)} />)
    const name = screen.getByRole('textbox', { name: 'Display name' }) as HTMLInputElement

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    expect((await screen.findByRole('alert')).textContent).toBe('The Form could not be saved.')
    expect(name.value).toBe('Grace')
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(1)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]).toEqual(initial)

    view.rerender(
      <RuntimeCard
        runtime={runtime}
        {...surfaceCardProps(
          SurfaceSchema.parse({
            ...initial,
            freshness: { updatedAt: '2026-09-01T08:00:30.000Z', updatedBy: 'agent' },
          }),
        )}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())

    const requestBodies = fetchMock.mock.calls.map(([, request]) =>
      JSON.parse(String(request?.body)),
    )
    expect(requestBodies[0]?.intentId).toBe(requestBodies[1]?.intentId)
    expect(requestBodies[1]?.inputs).toEqual({
      displayName: 'Grace',
      bio: 'First programmer',
    })
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
  })

  it('keeps a rejected draft visible and gives later submissions distinct intents', async () => {
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
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, request?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'This submission was rejected.' }), { status: 422 }),
      )
      .mockImplementationOnce(
        async (_input, request) =>
          new Response(
            JSON.stringify(
              committedActionOutcome(
                FastActionInvocationSchema.parse(JSON.parse(String(request?.body))),
                katherine,
                {
                  surfaceId: initial.id,
                  operations: [
                    { target: 'state', op: 'replace', path: '/displayName', value: 'Katherine' },
                  ],
                },
                2,
              ),
            ),
            { status: 200 },
          ),
      )
      .mockImplementationOnce(
        async (_input, request) =>
          new Response(
            JSON.stringify(
              committedActionOutcome(
                FastActionInvocationSchema.parse(JSON.parse(String(request?.body))),
                grace,
                {
                  surfaceId: initial.id,
                  operations: [
                    { target: 'state', op: 'replace', path: '/displayName', value: 'Grace' },
                  ],
                },
                3,
              ),
            ),
            { status: 200 },
          ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const runtime = await cardRuntime(initial)
    const view = render(<RuntimeCard runtime={runtime} {...surfaceCardProps(initial)} />)
    const name = screen.getByRole('textbox', { name: 'Display name' })
    const save = screen.getByRole('button', { name: 'Save profile' })

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(save)
    expect((await screen.findByRole('alert')).textContent).toBe('This submission was rejected.')
    expect(name).toHaveProperty('value', 'Grace')
    expect(runtime.getSnapshot().queuedFastActions).toHaveLength(0)
    expect(runtime.getSnapshot().spaces[0]?.surfaces[0]).toEqual(initial)

    fireEvent.change(name, { target: { value: 'Katherine' } })
    fireEvent.click(save)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    view.rerender(<RuntimeCard runtime={runtime} {...surfaceCardProps(katherine)} />)

    fireEvent.change(name, { target: { value: 'Grace' } })
    fireEvent.click(save)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))

    const requestBodies = fetchMock.mock.calls.map(([, request]) =>
      JSON.parse(String(request?.body)),
    )
    expect(requestBodies[0]?.intentId).not.toBe(requestBodies[1]?.intentId)
    expect(requestBodies[1]?.intentId).not.toBe(requestBodies[2]?.intentId)
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
      actions: [
        {
          name: 'submit',
          path: 'fast',
          revision: 'acr-profile',
          plan: formSetPlan(['displayName', 'bio']),
        },
      ],
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
    onTogglePin: vi.fn(),
    onRevealFeedbackShown: vi.fn(),
    ...overrides,
  }
}

async function cardRuntime(surface: ReturnType<typeof formSurface>): Promise<PwaLiveStateRuntime> {
  let handlers: api.GatewayHandlers | undefined
  const runtime = createPwaLiveStateRuntime({
    api: {
      ...api,
      fetchAuthStatus: async () => ({
        mode: 'dev',
        bootstrapRequired: false,
        passkeyRegistered: false,
      }),
      fetchSpaces: async () => ({
        surfaceCursor: 0,
        spaces: [
          {
            id: surface.spaceId,
            slug: 'health',
            name: 'Health',
            archived: false,
            attention: 0,
            attentionRevision: 0,
            surfaces: [surface],
          },
        ],
      }),
      fetchPendingDecisions: async () => ({ revision: 0, decisions: [] }),
      fetchChatTimeline: async () => ({ entries: [] }),
      fetchAutomationOutcomeNotifications: async () => ({ revision: 0, notifications: [] }),
      connectGateway: (nextHandlers) => {
        handlers = nextHandlers
        return { close: () => {}, sendChat: () => false }
      },
    },
  })
  runtimes.push(runtime)
  await runtime.start()
  if (!handlers) throw new Error('Expected a registered Gateway connection')
  handlers.onHello(0, 'surface-card-client')
  await vi.waitFor(() => expect(runtime.getSnapshot().gatewayOnline).toBe(true))
  return runtime
}

function RuntimeCard({
  runtime,
  ...props
}: ComponentProps<typeof SurfaceCard> & { runtime: PwaLiveStateRuntime }) {
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot)
  const surface =
    snapshot.spaces
      .flatMap((space) => space.surfaces)
      .find((surface) => surface.id === props.surface.id) ?? props.surface
  return (
    <PwaRuntimeContext.Provider value={runtime}>
      <SurfaceCard {...props} surface={surface} />
    </PwaRuntimeContext.Provider>
  )
}
