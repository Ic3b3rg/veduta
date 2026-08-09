import { describe, expect, it } from 'vitest'
import { ModelConnectionError } from './model-connection-adapter.ts'
import type { PiChatContext } from './pi-provider-bridge.ts'
import { renderSubscriptionPrompt, toSubscriptionPrompt } from './subscription-prompt.ts'

describe('toSubscriptionPrompt', () => {
  it('preserves roles and order and renders a tool result as text', () => {
    const context: PiChatContext = {
      systemPrompt: 'You are helpful.',
      messages: [
        { role: 'user', content: 'hi there', timestamp: 1 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'search_memory',
          content: [{ type: 'text', text: 'no results' }],
          isError: false,
          timestamp: 3,
        },
      ],
    }

    const prompt = toSubscriptionPrompt(context)

    expect(prompt.systemPrompt).toBe('You are helpful.')
    expect(prompt.messages).toEqual([
      { role: 'user', text: 'hi there' },
      { role: 'assistant', text: 'hello back' },
      { role: 'tool', toolName: 'search_memory', text: 'no results', isError: false },
    ])
  })

  it('falls back to an empty systemPrompt when absent', () => {
    const context: PiChatContext = { messages: [] }
    expect(toSubscriptionPrompt(context)).toEqual({ systemPrompt: '', messages: [] })
  })

  it('drops assistant thinking blocks and renders tool calls as history markers', () => {
    const context: PiChatContext = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'let me consider this' },
            { type: 'text', text: 'the answer' },
            { type: 'toolCall', id: 'call-2', name: 'search_memory', arguments: { q: 'x' } },
          ],
          api: 'anthropic-messages',
          provider: 'anthropic',
          model: 'claude-sonnet-5',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'toolUse',
          timestamp: 1,
        },
      ],
    }

    const prompt = toSubscriptionPrompt(context)

    expect(prompt.messages).toEqual([
      { role: 'assistant', text: 'the answer\n[tool call: search_memory]' },
    ])
  })

  it('declares an omitted image instead of dropping it silently', () => {
    const context: PiChatContext = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', data: 'base64==', mimeType: 'image/png' },
          ],
          timestamp: 1,
        },
        {
          role: 'toolResult',
          toolCallId: 'call-3',
          toolName: 'read_screenshot',
          content: [{ type: 'image', data: 'base64==', mimeType: 'image/jpeg' }],
          isError: true,
          timestamp: 2,
        },
      ],
    }

    const prompt = toSubscriptionPrompt(context)

    expect(prompt.messages).toEqual([
      { role: 'user', text: 'look at this\n[image omitted: image/png]' },
      {
        role: 'tool',
        toolName: 'read_screenshot',
        text: '[image omitted: image/jpeg]',
        isError: true,
      },
    ])
  })

  it('throws unsupported when the context still carries tools', () => {
    const context: PiChatContext = {
      messages: [],
      tools: [{ name: 'search_memory', description: 'search', parameters: {} }],
    }

    expect(() => toSubscriptionPrompt(context)).toThrow(ModelConnectionError)
    try {
      toSubscriptionPrompt(context)
      throw new Error('expected toSubscriptionPrompt to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ModelConnectionError)
      expect((error as ModelConnectionError).code).toBe('unsupported')
      expect((error as ModelConnectionError).message).toBe(
        'this Model connection answers in text only; refusing a turn that was given Veduta tools',
      )
    }
  })

  it('does not throw for an empty tools array', () => {
    const context: PiChatContext = { messages: [], tools: [] }
    expect(() => toSubscriptionPrompt(context)).not.toThrow()
  })
})

describe('renderSubscriptionPrompt', () => {
  it('matches its snapshot', () => {
    const rendered = renderSubscriptionPrompt({
      systemPrompt: 'You are Veduta.',
      messages: [
        { role: 'user', text: 'what is on my calendar today?' },
        { role: 'assistant', text: 'checking now' },
        { role: 'tool', toolName: 'search_memory', text: 'no results', isError: false },
        {
          role: 'tool',
          toolName: 'send_email',
          text: 'the account is not connected',
          isError: true,
        },
      ],
    })

    expect(rendered).toMatchInlineSnapshot(`
      "You are Veduta.

      ---

      User:
      what is on my calendar today?

      Assistant:
      checking now

      Tool search_memory:
      no results

      Tool send_email (error):
      the account is not connected"
    `)
  })
})
