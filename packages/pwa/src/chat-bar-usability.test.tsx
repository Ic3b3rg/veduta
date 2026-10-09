// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import type { PendingDecision, PendingDecisionOutcome } from '@veduta/protocol'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatBar } from './chat-bar.tsx'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function props(): ComponentProps<typeof ChatBar> {
  return {
    entries: [],
    timelineEntries: [],
    hasOlder: false,
    loadingOlder: false,
    queuedChat: [],
    streamingEntries: [],
    focusedSpace: undefined,
    focusToken: 'initial',
    focusOnRouteChange: true,
    pendingDecisionReviewPaths: new Map(),
    dismissedDecisionIds: new Set(),
    resolvingDecisionIds: new Set(),
    onResolvePendingDecision: vi.fn(),
    onDismissPendingDecision: vi.fn(),
    onSend: vi.fn(() => true),
    onLoadOlder: vi.fn(),
    onRetryInterrupted: vi.fn(),
    onRetryQueued: vi.fn(),
  }
}

function mobile() {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) =>
      fromPartial<MediaQueryList>({ matches: query === '(pointer: coarse)' }),
    ),
  )
}

it.each<{ outcome: PendingDecisionOutcome; label: string; tone: string }>([
  { outcome: 'accepted', label: 'Accepted', tone: 'success' },
  { outcome: 'executed', label: 'Executed', tone: 'success' },
  { outcome: 'applied', label: 'Applied', tone: 'success' },
  { outcome: 'rejected', label: 'Rejected', tone: 'muted' },
  { outcome: 'failed', label: 'Failed', tone: 'danger' },
  { outcome: 'refused', label: 'Refused', tone: 'danger' },
  { outcome: 'rolled-back', label: 'Rolled back', tone: 'danger' },
  { outcome: 'expired', label: 'Expired', tone: 'warning' },
  { outcome: 'stale', label: 'Stale', tone: 'warning' },
  { outcome: 'indeterminate', label: 'Indeterminate', tone: 'warning' },
])(
  'presents $outcome as labelled $tone feedback without resolution controls',
  ({ outcome, label, tone }) => {
    const input = props()
    input.entries = [
      {
        role: 'assistant',
        text: 'Decision result',
        pendingDecisions: [
          fromPartial<PendingDecision>({
            id: 'approval:result',
            summary: 'Send appointment',
            state: 'terminal',
            outcome,
          }),
        ],
      },
    ]
    render(
      <MemoryRouter>
        <ChatBar {...input} />
      </MemoryRouter>,
    )
    expect(screen.getByText(label).getAttribute('data-tone')).toBe(tone)
    expect(screen.queryByRole('button', { name: /Approve|Reject/ })).toBeNull()
  },
)

it('mobile Enter does not submit a draft', () => {
  mobile()
  const input = props()
  render(
    <MemoryRouter>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  const field = screen.getByRole('textbox')
  fireEvent.change(field, { target: { value: 'first line' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(input.onSend).not.toHaveBeenCalled()
  fireEvent.change(field, { target: { value: 'first line\nsecond line' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(input.onSend).toHaveBeenCalledWith('first line\nsecond line')
})

it('desktop IME confirmation does not submit a draft', () => {
  const input = props()
  render(
    <MemoryRouter>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  const field = screen.getByRole('textbox')
  fireEvent.change(field, { target: { value: 'composing' } })
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
  expect(input.onSend).not.toHaveBeenCalled()
})

it('mobile navigation preserves the initiating control focus', () => {
  mobile()
  const input = props()
  const view = render(
    <MemoryRouter>
      <button>Change Surface</button>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  const navigation = screen.getByRole('button', { name: 'Change Surface' })
  navigation.focus()
  view.rerender(
    <MemoryRouter>
      <button>Change Surface</button>
      <ChatBar {...input} focusToken="next-surface" />
    </MemoryRouter>,
  )
  expect(document.activeElement).toBe(navigation)
  screen.getByRole('textbox').focus()
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
})

it('desktop navigation still focuses the composer', () => {
  const input = props()
  const view = render(
    <MemoryRouter>
      <button>Change Surface</button>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  screen.getByRole('button', { name: 'Change Surface' }).focus()
  view.rerender(
    <MemoryRouter>
      <button>Change Surface</button>
      <ChatBar {...input} focusToken="next-surface" />
    </MemoryRouter>,
  )
  expect(document.activeElement).toBe(screen.getByRole('textbox'))
})

it('a subpixel distance from the end counts as being at the bottom', () => {
  render(
    <MemoryRouter>
      <ChatBar {...props()} />
    </MemoryRouter>,
  )
  const log = screen.getByRole('log')
  Object.defineProperties(log, {
    scrollHeight: { value: 300 },
    clientHeight: { value: 100 },
    scrollTop: { value: 200, writable: true },
  })
  fireEvent.scroll(log)
  log.scrollTop = 199.75
  fireEvent.scroll(log)
  expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()
})

it('hides the latest-message control when resizing makes the end visible', () => {
  let resize = () => {}
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  render(
    <MemoryRouter>
      <ChatBar {...props()} />
    </MemoryRouter>,
  )
  const log = screen.getByRole('log')
  Object.defineProperties(log, {
    scrollHeight: { value: 300 },
    clientHeight: { value: 100, configurable: true },
    scrollTop: { value: 40, writable: true },
  })
  act(resize)
  log.scrollTop = 40
  fireEvent.scroll(log)
  expect(screen.getByRole('button', { name: 'Scroll to latest message' })).toBeTruthy()
  act(() => {
    Object.defineProperty(log, 'clientHeight', { value: 260 })
    resize()
  })
  expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()
})

it('an active streaming animation does not also show Running under the sent message', () => {
  const input = props()
  input.entries = [{ role: 'user', text: 'hello' }]
  input.timelineEntries = [
    fromPartial({ kind: 'user', turnId: 'running-turn', turnState: 'running' }),
  ]
  input.streamingEntries = [{ turnId: 'running-turn', text: '' }]
  render(
    <MemoryRouter>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  expect(screen.getByTestId('chat-streaming-cursor')).toBeTruthy()
  expect(screen.queryByText('Running')).toBeNull()
})

it('keeps running feedback without its own stream, queued work and connection waits', () => {
  const input = props()
  input.entries = [
    { role: 'user', text: 'running on another device' },
    { role: 'user', text: 'queued message' },
    { role: 'user', text: 'needs a connection' },
  ]
  input.timelineEntries = [
    fromPartial({ id: 'entry-1', kind: 'user', turnId: 'turn-1', turnState: 'running' }),
    fromPartial({ id: 'entry-2', kind: 'user', turnId: 'turn-2', turnState: 'accepted' }),
    fromPartial({ id: 'entry-3', kind: 'user', turnId: 'turn-3', turnState: 'waiting_connection' }),
  ]
  input.streamingEntries = [{ turnId: 'other-turn', text: '' }]
  render(
    <MemoryRouter>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  expect(screen.getByText('Running')).toBeTruthy()
  expect(screen.getByText('Queued')).toBeTruthy()
  expect(screen.getByText('Waiting for service connection')).toBeTruthy()
})

it('Agent replies render the supported Markdown syntax', () => {
  const input = props()
  input.entries = [{ role: 'assistant', text: '**Important**\n\n- First item' }]
  render(
    <MemoryRouter>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  expect(screen.queryAllByRole('listitem')).toHaveLength(1)
  expect(screen.queryByText('Important')?.tagName).toBe('STRONG')
})

it('renders streaming Markdown safely and keeps the same semantics after completion', () => {
  const text =
    '## Result\n\n**Important** and *useful*\n\n- First item\n\n[Documentation](https://example.org/docs) [unsafe](javascript:alert)\n\n<img src=x onerror=alert(1)>\n\n```\nconst value = 1\n```'
  const input = props()
  input.entries = [{ role: 'user', text: '**Keep my syntax**' }]
  input.streamingEntries = [{ turnId: 'turn-1', text }]
  const view = render(
    <MemoryRouter>
      <ChatBar {...input} />
    </MemoryRouter>,
  )
  const assertContent = () => {
    expect(screen.getByRole('heading', { name: 'Result' })).toBeTruthy()
    expect(screen.getByText('Important').tagName).toBe('STRONG')
    expect(screen.getByText('useful').tagName).toBe('EM')
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(screen.getByRole('link', { name: 'Documentation' }).getAttribute('href')).toBe(
      'https://example.org/docs',
    )
    expect(screen.queryByRole('link', { name: 'unsafe' })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy()
    expect(screen.getByText('const value = 1').tagName).toBe('CODE')
    expect(screen.getByText('**Keep my syntax**')).toBeTruthy()
  }
  assertContent()
  view.rerender(
    <MemoryRouter>
      <ChatBar
        {...input}
        entries={[...input.entries, { role: 'assistant', text }]}
        streamingEntries={[]}
      />
    </MemoryRouter>,
  )
  assertContent()
  expect(screen.queryByTestId('chat-streaming-cursor')).toBeNull()
})
