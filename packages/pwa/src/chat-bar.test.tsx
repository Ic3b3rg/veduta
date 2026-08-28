// @vitest-environment jsdom
import type { ChatMessage, PendingDecision } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBar } from './chat-bar.tsx'

const scrollTops = new WeakMap<HTMLElement, number>()
const scrollHeights = new WeakMap<HTMLElement, number>()

beforeEach(() => {
  history.replaceState(null, '', '/')
  Object.defineProperties(HTMLElement.prototype, {
    clientHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains('chat-log') ? 100 : 0
      },
    },
    scrollHeight: {
      configurable: true,
      get(this: HTMLElement) {
        return scrollHeights.get(this) ?? (this.classList.contains('chat-log') ? 300 : 0)
      },
    },
    scrollTop: {
      configurable: true,
      get(this: HTMLElement) {
        return scrollTops.get(this) ?? 0
      },
      set(this: HTMLElement, value: number) {
        const maximum = Math.max(0, this.scrollHeight - this.clientHeight)
        scrollTops.set(this, Math.min(Math.max(0, value), maximum))
      },
    },
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTop')
})

function renderChatBar(
  entries: ChatMessage[],
  streamingEntries: { turnId: string; text: string }[],
  onResolvePendingDecision = vi.fn(async () => undefined),
  pendingDecisionReviewPaths: ReadonlyMap<string, string> = new Map(),
  resolvingDecisionIds: ReadonlySet<string> = new Set(),
) {
  const chatBar = (
    nextEntries: ChatMessage[],
    nextStreamingEntries: { turnId: string; text: string }[],
  ) => (
    <MemoryRouter>
      <ChatBar
        entries={nextEntries}
        streamingEntries={nextStreamingEntries}
        focusedSpace={undefined}
        focusToken="initial"
        focusOnRouteChange
        pendingDecisionReviewPaths={pendingDecisionReviewPaths}
        resolvingDecisionIds={resolvingDecisionIds}
        onResolvePendingDecision={onResolvePendingDecision}
        onSend={vi.fn(() => true)}
      />
    </MemoryRouter>
  )
  const view = render(chatBar(entries, streamingEntries))

  return {
    ...view,
    onResolvePendingDecision,
    rerenderChatBar(
      nextEntries: ChatMessage[],
      nextStreamingEntries: { turnId: string; text: string }[],
    ) {
      view.rerender(chatBar(nextEntries, nextStreamingEntries))
    },
  }
}

describe('ChatBar', () => {
  it('opens a loaded conversation at the latest message', () => {
    renderChatBar([{ role: 'assistant', text: 'the latest message' }], [])

    const conversation = screen.getByRole('log', { name: 'Conversation' })
    expect(conversation.scrollTop).toBe(200)
  })

  it('keeps following the latest message while the conversation is at the bottom', () => {
    const view = renderChatBar([{ role: 'user', text: 'hello' }], [])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    scrollHeights.set(conversation, 400)

    view.rerenderChatBar(
      [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
      ],
      [],
    )

    expect(conversation.scrollTop).toBe(300)
  })

  it('follows a streamed reply as it grows at the bottom', () => {
    const entries: ChatMessage[] = []
    const view = renderChatBar(entries, [{ turnId: 'turn-1', text: 'partial' }])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    scrollHeights.set(conversation, 400)

    view.rerenderChatBar(entries, [{ turnId: 'turn-1', text: 'partial reply grows' }])

    expect(conversation.scrollTop).toBe(300)
  })

  it('preserves the reading position when the reader scrolls away from the bottom', () => {
    const entries: ChatMessage[] = []
    const view = renderChatBar(entries, [{ turnId: 'turn-1', text: 'partial' }])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    conversation.scrollTop = 40
    fireEvent.scroll(conversation)
    scrollHeights.set(conversation, 400)

    view.rerenderChatBar(entries, [{ turnId: 'turn-1', text: 'partial reply grows' }])

    expect(conversation.scrollTop).toBe(40)
  })

  it('honors even a one-pixel upward scroll before more streamed text arrives', () => {
    const entries: ChatMessage[] = []
    const view = renderChatBar(entries, [{ turnId: 'turn-1', text: 'partial' }])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    conversation.scrollTop = 199
    fireEvent.scroll(conversation)
    scrollHeights.set(conversation, 400)

    view.rerenderChatBar(entries, [{ turnId: 'turn-1', text: 'partial reply grows' }])

    expect(conversation.scrollTop).toBe(199)
  })

  it('offers a return to the latest message only while the reader is away from the bottom', () => {
    renderChatBar([{ role: 'assistant', text: 'latest' }], [])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()

    conversation.scrollTop = 40
    fireEvent.scroll(conversation)
    expect(screen.getByRole('button', { name: 'Scroll to latest message' })).toBeDefined()

    conversation.scrollTop = 200
    fireEvent.scroll(conversation)
    expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()
  })

  it('returns to the latest message and resumes following after the scroll button is pressed', () => {
    const entries: ChatMessage[] = []
    const view = renderChatBar(entries, [{ turnId: 'turn-1', text: 'partial' }])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    conversation.scrollTop = 40
    fireEvent.scroll(conversation)

    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest message' }))
    expect(conversation.scrollTop).toBe(200)
    expect(screen.queryByRole('button', { name: 'Scroll to latest message' })).toBeNull()

    scrollHeights.set(conversation, 400)
    view.rerenderChatBar(entries, [{ turnId: 'turn-1', text: 'partial reply grows' }])
    expect(conversation.scrollTop).toBe(300)
  })

  it('resumes following after the reader manually returns to the bottom', () => {
    const entries: ChatMessage[] = []
    const view = renderChatBar(entries, [{ turnId: 'turn-1', text: 'partial' }])
    const conversation = screen.getByRole('log', { name: 'Conversation' })
    conversation.scrollTop = 40
    fireEvent.scroll(conversation)
    conversation.scrollTop = 200
    fireEvent.scroll(conversation)
    scrollHeights.set(conversation, 400)

    view.rerenderChatBar(entries, [{ turnId: 'turn-1', text: 'partial reply grows' }])

    expect(conversation.scrollTop).toBe(300)
  })

  it('renders persisted entries with no in-progress affordance', () => {
    renderChatBar([{ role: 'assistant', text: 'the complete final answer' }], [])

    expect(screen.getByText('the complete final answer')).toBeDefined()
    expect(screen.queryByTestId('chat-streaming-cursor')).toBeNull()
  })

  it('renders accessible result links without navigating automatically', () => {
    renderChatBar(
      [
        {
          role: 'assistant',
          text: 'Both results are ready.',
          targets: [
            {
              spaceId: 'spc-health',
              spaceSlug: 'health',
              spaceName: 'Health',
              surfaceId: 'srf-weight',
              surfaceTitle: 'Weight tracker',
            },
            {
              spaceId: 'spc-work',
              spaceSlug: 'work',
              spaceName: 'Work',
            },
          ],
        },
      ],
      [],
    )

    expect(
      screen.getByRole('link', { name: 'Open Health · Weight tracker' }).getAttribute('href'),
    ).toBe('/app/space/health/surface/srf-weight')
    expect(screen.getByRole('link', { name: 'Open Work' }).getAttribute('href')).toBe(
      '/app/space/work',
    )
    expect(location.pathname).toBe('/')
  })

  it('renders one-tap actions for a pending Space proposal', async () => {
    const onResolvePendingDecision = vi.fn(async () => undefined)
    renderChatBar(
      [
        {
          role: 'assistant',
          text: 'Travel needs its own Space.',
          pendingDecisions: [
            {
              id: 'space-proposal:proposal-1',
              kind: 'space-proposal',
              summary: 'Create Space “Travel”',
              scope: { type: 'global' },
              allowedResolutions: ['accept', 'reject'],
              state: 'pending',
              createdAt: '2026-08-25T10:00:00.000Z',
            },
          ],
        },
      ],
      [],
      onResolvePendingDecision,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Accept Create Space “Travel”' }))

    await waitFor(() =>
      expect(onResolvePendingDecision).toHaveBeenCalledWith('space-proposal:proposal-1', 'accept'),
    )
    expect(location.pathname).toBe('/')
  })

  it('reviews an assigned chat decision through its exact Decision Surface', () => {
    const pendingDecision: PendingDecision = {
      id: 'tree-proposal:proposal-1',
      kind: 'tree-proposal',
      summary: 'Update the weekly plan',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      decisionSurfaceId: 'srf-decision-1',
      createdAt: '2026-08-25T10:00:00.000Z',
    }
    renderChatBar(
      [
        {
          role: 'assistant',
          text: 'The weekly plan needs review.',
          pendingDecisions: [pendingDecision],
        },
      ],
      [],
      vi.fn(async () => undefined),
      new Map([[pendingDecision.id, '/app/space/health/surface/srf-decision-1']]),
    )

    expect(
      screen.getByRole('link', { name: 'Review Update the weekly plan' }).getAttribute('href'),
    ).toBe('/app/space/health/surface/srf-decision-1')
  })

  it('renders a streaming entry with the accumulated text and the in-progress affordance', () => {
    renderChatBar([], [{ turnId: 'turn-1', text: 'partial ans' }])

    expect(screen.getByText('partial ans', { exact: false })).toBeDefined()
    expect(screen.getByTestId('chat-streaming-cursor')).toBeDefined()
  })

  it('renders streaming entries after the persisted entries, each keyed by turnId', () => {
    const { container } = renderChatBar(
      [
        { role: 'user', text: 'hello' },
        { role: 'assistant', text: 'hi there' },
      ],
      [
        { turnId: 'turn-a', text: 'streaming a' },
        { turnId: 'turn-b', text: 'streaming b' },
      ],
    )

    const texts = [...container.querySelectorAll('.chat-entry > span')].map(
      (span) => span.textContent,
    )
    expect(texts).toEqual(['hello', 'hi there', 'streaming a', 'streaming b'])

    const streamingRows = container.querySelectorAll('.chat-entry.streaming')
    expect(streamingRows).toHaveLength(2)
  })

  it('keeps the composer usable while a turn is streaming', () => {
    renderChatBar([], [{ turnId: 'turn-1', text: 'still going' }])

    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.disabled).toBe(false)
  })
})
