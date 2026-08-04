import { describe, expect, it } from 'vitest'
import { turnFailureStatus } from './pi-agent-runner.ts'
import type { PiChatContext } from './pi-provider-bridge.ts'
import {
  createFakeProvider,
  fakeFailure,
  fakeFailureWithText,
  fakeText,
  fakeTextAndToolCall,
  fakeToolCall,
  fakeUsage,
} from './fake-provider.ts'

function minimalContext(): PiChatContext {
  return { messages: [] }
}

describe('createFakeProvider', () => {
  it('resolves its one registered model and rejects any other provider/model', () => {
    const fake = createFakeProvider()
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    expect(model.id).toBe('fake-model')
    expect(() =>
      fake.resolveModel({ provider: 'anthropic', modelId: 'fake-model', tier: 'reasoning' }),
    ).toThrow(/anthropic/)
    expect(() =>
      fake.resolveModel({ provider: 'fake', modelId: 'no-such-model', tier: 'reasoning' }),
    ).toThrow(/no-such-model/)
  })

  it('getApiKey always returns a defined key (the fake never makes a real call)', () => {
    const fake = createFakeProvider()
    expect(fake.getApiKey('fake')).toBeDefined()
  })

  it('delivers a scripted text message with its scripted usage cost on result()', async () => {
    const fake = createFakeProvider()
    fake.setResponses([{ message: fakeText('scripted reply'), usage: fakeUsage(0.042) }])
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    const stream = await fake.streamFn(model, minimalContext(), {})
    for await (const _event of stream) {
      // drain to completion
    }
    const message = await stream.result()
    expect(message.content).toEqual([{ type: 'text', text: 'scripted reply' }])
    expect(message.usage.cost.total).toBeCloseTo(0.042)
  })

  it('delivers a scripted tool call', async () => {
    const fake = createFakeProvider()
    fake.setResponses([{ message: fakeToolCall('spawn_worker', { topic: 'weather' }) }])
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    const stream = await fake.streamFn(model, minimalContext(), {})
    for await (const _event of stream) {
      // drain to completion
    }
    const message = await stream.result()
    expect(message.content).toEqual([
      expect.objectContaining({
        type: 'toolCall',
        name: 'spawn_worker',
        arguments: { topic: 'weather' },
      }),
    ])
  })

  it('fakeTextAndToolCall delivers both a text block and a tool call in one message', async () => {
    const fake = createFakeProvider()
    fake.setResponses([{ message: fakeTextAndToolCall('Logged: a pizza.', 'patch_state', {}) }])
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    const stream = await fake.streamFn(model, minimalContext(), {})
    for await (const _event of stream) {
      // drain to completion
    }
    const message = await stream.result()
    expect(message.stopReason).toBe('toolUse')
    expect(message.content).toEqual([
      { type: 'text', text: 'Logged: a pizza.' },
      expect.objectContaining({ type: 'toolCall', name: 'patch_state' }),
    ])
  })

  it('drives a factory step with the live call count', async () => {
    const fake = createFakeProvider()
    const seenCallCounts: number[] = []
    function stepFor(text: string) {
      return {
        factory: (_context: PiChatContext, state: { callCount: number }) => {
          seenCallCounts.push(state.callCount)
          return fakeText(text)
        },
      }
    }
    fake.setResponses([stepFor('one'), stepFor('two')])
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    for (const expected of ['one', 'two']) {
      const stream = await fake.streamFn(model, minimalContext(), {})
      for await (const _event of stream) {
        // drain to completion
      }
      const message = await stream.result()
      expect(message.content).toEqual([{ type: 'text', text: expected }])
    }
    // pi-ai's faux core increments `state.callCount` before invoking the
    // step (`createFauxCore`'s `stream()`, `@earendil-works/pi-ai/providers/faux`),
    // so the first call already observes 1, not 0.
    expect(seenCallCounts).toEqual([1, 2])
  })

  it('fakeFailure(status) produces an error-stopped message parseable by turnFailureStatus', async () => {
    const fake = createFakeProvider()
    fake.setResponses([{ message: fakeFailure(429) }])
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    const stream = await fake.streamFn(model, minimalContext(), {})
    for await (const _event of stream) {
      // drain to completion
    }
    const message = await stream.result()
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toBe('HTTP 429: injected failure')
    expect(turnFailureStatus(message.errorMessage ?? '')).toBe(429)
  })

  it('fakeFailureWithText(status, text) streams the given text as deltas before ending in the same error-stopped shape as fakeFailure', async () => {
    const fake = createFakeProvider()
    fake.setResponses([{ message: fakeFailureWithText(500, 'partial reply before the crash') }])
    const model = fake.resolveModel({ provider: 'fake', modelId: 'fake-model', tier: 'reasoning' })
    const stream = await fake.streamFn(model, minimalContext(), {})
    let streamedText = ''
    for await (const event of stream) {
      if (event.type === 'text_delta') streamedText += event.delta
    }
    expect(streamedText).toBe('partial reply before the crash')
    const message = await stream.result()
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toBe('HTTP 500: injected failure')
    expect(turnFailureStatus(message.errorMessage ?? '')).toBe(500)
  })

  it('appendResponses extends the same queue setResponses started, tracked by pendingCount', () => {
    const fake = createFakeProvider()
    fake.setResponses([{ message: fakeText('a') }])
    expect(fake.pendingCount()).toBe(1)
    fake.appendResponses([{ message: fakeText('b') }, { message: fakeText('c') }])
    expect(fake.pendingCount()).toBe(3)
  })
})
