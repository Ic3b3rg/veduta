// @vitest-environment jsdom
import type { ApprovalCard, ChatMessage } from '@veduta/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatBar } from './chat-bar.tsx'

afterEach(cleanup)

const noApprovalCards: ApprovalCard[] = []

function renderChatBar(
  entries: ChatMessage[],
  streamingEntries: { turnId: string; text: string }[],
) {
  return render(
    <ChatBar
      entries={entries}
      streamingEntries={streamingEntries}
      approvalCards={noApprovalCards}
      focusedSpace={undefined}
      focusToken={0}
      onDismissApprovalCards={vi.fn()}
      onSend={vi.fn(() => true)}
    />,
  )
}

describe('ChatBar', () => {
  it('renders persisted entries with no in-progress affordance', () => {
    renderChatBar([{ role: 'assistant', text: 'the complete final answer' }], [])

    expect(screen.getByText('the complete final answer')).toBeDefined()
    expect(screen.queryByTestId('chat-streaming-cursor')).toBeNull()
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
