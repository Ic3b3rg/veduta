// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import type { ComponentProps } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatPanel } from './chat-panel.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function props(): ComponentProps<typeof ChatPanel> {
  return {
    entries: [{ role: 'assistant', text: 'Your plan is ready.' }],
    timelineEntries: [],
    hasOlder: false,
    loadingOlder: false,
    queuedChat: [],
    streamingEntries: [],
    focusedSpace: undefined,
    focusToken: 'initial',
    focusOnRouteChange: false,
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

it('opens mobile Chat for reading, preserves its draft on close, and returns focus to the icon', async () => {
  vi.stubGlobal('matchMedia', (query: string) =>
    fromPartial<MediaQueryList>({
      matches: query === '(max-width: 959px)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
  const input = props()
  render(
    <MemoryRouter>
      <ChatPanel {...input} />
    </MemoryRouter>,
  )

  const launcher = screen.getByRole('button', { name: 'Open Chat' })
  expect(launcher.textContent).toBe('')
  expect(screen.queryByRole('textbox')).toBeNull()
  fireEvent.click(launcher)
  await screen.findByRole('dialog', { name: 'Chat Global' })
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Chat Global' })),
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First line\nSecond line' } })
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(input.onSend).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Back to Space' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(launcher)

  fireEvent.click(launcher)
  expect(screen.getByRole('textbox').getAttribute('aria-label')).toBe('Message Veduta')
  expect(fromPartial<HTMLTextAreaElement>(screen.getByRole('textbox')).value).toBe(
    'First line\nSecond line',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }))
  expect(input.onSend).toHaveBeenCalledWith('First line\nSecond line')
})

it('keeps drafts separate when switching Chat scope', () => {
  const input = props()
  const view = render(
    <MemoryRouter>
      <ChatPanel {...input} />
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Global draft' } })
  view.rerender(
    <MemoryRouter>
      <ChatPanel {...input} focusedSpace={fromPartial({ id: 'spc-health', name: 'Health' })} />
    </MemoryRouter>,
  )
  expect(screen.getByRole('textbox')).toHaveProperty('value', '')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Health draft' } })
  view.rerender(
    <MemoryRouter>
      <ChatPanel {...input} />
    </MemoryRouter>,
  )
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Global draft')
})

it('keeps the visible message in place when an older page is loaded', () => {
  const input: ComponentProps<typeof ChatPanel> = {
    ...props(),
    hasOlder: true,
    timelineEntries: [fromPartial({ id: 'current', kind: 'assistant' })],
  }
  const view = render(
    <MemoryRouter>
      <ChatPanel {...input} />
    </MemoryRouter>,
  )
  const log = screen.getByRole('log')
  Object.defineProperties(log, { clientHeight: { value: 300 }, scrollHeight: { value: 1000 } })
  fireEvent.scroll(log)
  log.scrollTop = 100
  fireEvent.scroll(log)
  let messageTop = 100
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return fromPartial<DOMRect>({
      top: this.dataset.chatEntryId === 'current' ? messageTop - log.scrollTop : 0,
    })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Load older messages' }))
  expect(input.onLoadOlder).toHaveBeenCalledOnce()
  messageTop = 600
  view.rerender(
    <MemoryRouter>
      <ChatPanel
        {...input}
        entries={[{ role: 'assistant', text: 'Earlier reply' }, ...input.entries]}
        timelineEntries={[
          fromPartial({ id: 'older', kind: 'assistant' }),
          ...input.timelineEntries,
        ]}
      />
    </MemoryRouter>,
  )
  expect(log.scrollTop).toBe(600)
})
