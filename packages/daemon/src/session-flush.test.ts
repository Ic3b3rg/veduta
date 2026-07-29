import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it, vi } from 'vitest'
import type { ContextPolicy, ContextPolicyContext, SessionMessage } from './agent-runner.ts'
import { disabledContextPolicy } from './agent-runner.ts'
import {
  createFactFlush,
  withPreCompactionFlush,
  type PreCompactionFlush,
} from './session-flush.ts'

const context: ContextPolicyContext = { sessionId: 'session-1' }

/** A fake compacting policy: awaits `beforeCompact` (possibly more than once), records that it did, then returns `compacted`. */
function compactingPolicy(order: string[], compacted: SessionMessage[], calls = 1): ContextPolicy {
  return {
    enabled: true,
    async transform(_messages, ctx) {
      for (let i = 0; i < calls; i += 1) {
        await ctx.beforeCompact?.()
      }
      order.push('compacted')
      return compacted
    },
  }
}

/** A fake policy that never calls `beforeCompact` at all. */
function passthroughPolicy(): ContextPolicy {
  return {
    enabled: true,
    async transform(messages) {
      return messages
    },
  }
}

function recordingFlush(order: string[]): PreCompactionFlush {
  return async () => {
    order.push('flushed')
  }
}

describe('withPreCompactionFlush', () => {
  it('runs the flush strictly before the policy compacts', async () => {
    const order: string[] = []
    const compacted: SessionMessage[] = [fromPartial({ role: 'assistant', content: 'summary' })]
    const policy = withPreCompactionFlush(compactingPolicy(order, compacted), recordingFlush(order))

    const input: SessionMessage[] = [fromPartial({ role: 'user', content: 'hello' })]
    const result = await policy.transform(input, context)

    expect(order).toEqual(['flushed', 'compacted'])
    expect(result).toBe(compacted)
  })

  it('runs the flush at most once per transform, even when the policy calls beforeCompact twice', async () => {
    const order: string[] = []
    let flushCalls = 0
    const flush: PreCompactionFlush = async () => {
      flushCalls += 1
      order.push('flushed')
    }
    const compacted: SessionMessage[] = []
    const policy = withPreCompactionFlush(compactingPolicy(order, compacted, 2), flush)

    await policy.transform([fromPartial({ role: 'user', content: 'hi' })], context)

    expect(flushCalls).toBe(1)
    expect(order).toEqual(['flushed', 'compacted'])
  })

  it('never runs the flush when the inner policy never calls beforeCompact, and passes output through', async () => {
    let flushCalls = 0
    const flush: PreCompactionFlush = async () => {
      flushCalls += 1
    }
    const policy = withPreCompactionFlush(passthroughPolicy(), flush)
    const input: SessionMessage[] = [fromPartial({ role: 'user', content: 'hi' })]

    const result = await policy.transform(input, context)

    expect(flushCalls).toBe(0)
    // Content equality, not identity: the wrapper hands the policy a copy so
    // that discarding its return value on a failed flush is enough to undo it,
    // and the input array is left untouched either way.
    expect(result).toEqual(input)
    expect(input).toHaveLength(1)
  })

  it('wraps disabledContextPolicy as a no-op: messages pass through, flush never runs, enabled stays false', async () => {
    let flushCalls = 0
    const flush: PreCompactionFlush = async () => {
      flushCalls += 1
    }
    const policy = withPreCompactionFlush(disabledContextPolicy, flush)
    const input: SessionMessage[] = [fromPartial({ role: 'user', content: 'hi' })]

    const result = await policy.transform(input, context)

    expect(policy.enabled).toBe(false)
    expect(flushCalls).toBe(0)
    expect(result).toEqual(input)
    expect(input).toHaveLength(1)
  })

  it('fails closed: a throwing flush returns the untransformed input and the policy compaction does not take effect', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const compacted: SessionMessage[] = [fromPartial({ role: 'assistant', content: 'summary' })]
      const policy = withPreCompactionFlush(compactingPolicy([], compacted), async () => {
        throw new Error('flush storage unavailable')
      })
      const input: SessionMessage[] = [fromPartial({ role: 'user', content: 'hi' })]

      const result = await policy.transform(input, context)

      expect(result).toBe(input)
      expect(result).not.toBe(compacted)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toBe('pre-compaction session flush failed')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('propagates a rejection thrown by the policy itself, unrelated to the flush', async () => {
    let flushCalls = 0
    const failingPolicy: ContextPolicy = {
      enabled: true,
      async transform(_messages, ctx) {
        await ctx.beforeCompact?.()
        throw new Error('policy exploded for its own reasons')
      },
    }
    const policy = withPreCompactionFlush(failingPolicy, async () => {
      flushCalls += 1
    })

    await expect(
      policy.transform([fromPartial({ role: 'user', content: 'hi' })], context),
    ).rejects.toThrow('policy exploded for its own reasons')
    expect(flushCalls).toBe(1)
  })

  it('propagates a rejection from a policy that throws without ever calling beforeCompact', async () => {
    const failingPolicy: ContextPolicy = {
      enabled: true,
      transform() {
        throw new Error('policy refused the input')
      },
    }
    const policy = withPreCompactionFlush(failingPolicy, async () => {})

    await expect(
      policy.transform([fromPartial({ role: 'user', content: 'hi' })], context),
    ).rejects.toThrow('policy refused the input')
  })

  it('gives two concurrent transforms their own once-guard', async () => {
    const flushedFor: string[] = []
    const flush: PreCompactionFlush = async (messages) => {
      // Yield so the two concurrent calls interleave before recording.
      await Promise.resolve()
      flushedFor.push(messages[0]?.content ?? '')
    }
    const policy = withPreCompactionFlush(compactingPolicy([], []), flush)

    await Promise.all([
      policy.transform([fromPartial({ role: 'user', content: 'session-a' })], {
        sessionId: 'a',
      }),
      policy.transform([fromPartial({ role: 'user', content: 'session-b' })], {
        sessionId: 'b',
      }),
    ])

    expect(flushedFor.sort()).toEqual(['session-a', 'session-b'])
  })
})

describe('createFactFlush', () => {
  it('calls writeFact once per extracted fact', async () => {
    const written: Array<{ fact: string; origin: string }> = []
    const flush = createFactFlush({
      writeFact: (fact, origin) => {
        written.push({ fact, origin })
      },
      extractFacts: () => ['fact one', 'fact two'],
    })

    await flush([fromPartial({ role: 'user', content: 'hi' })], context)

    expect(written.map((entry) => entry.fact)).toEqual(['fact one', 'fact two'])
  })

  it('stamps the untrusted origin when the session saw untrusted content', async () => {
    const written: Array<{ fact: string; origin: string }> = []
    const flush = createFactFlush({
      writeFact: (fact, origin) => {
        written.push({ fact, origin })
      },
      extractFacts: () => ['weighed 70kg'],
    })
    const messages: SessionMessage[] = [
      fromPartial({ role: 'user', content: 'hi', origin: 'trusted:user' }),
      fromPartial({ role: 'tool', content: 'inbox item', origin: 'untrusted:gmail' }),
    ]

    await flush(messages, context)

    expect(written).toEqual([{ fact: 'weighed 70kg', origin: 'untrusted:gmail' }])
  })

  it('stamps trusted:system when every message is trusted', async () => {
    const written: Array<{ fact: string; origin: string }> = []
    const flush = createFactFlush({
      writeFact: (fact, origin) => {
        written.push({ fact, origin })
      },
      extractFacts: () => ['weighed 70kg'],
    })
    const messages: SessionMessage[] = [
      fromPartial({ role: 'user', content: 'hi', origin: 'trusted:user' }),
      fromPartial({ role: 'assistant', content: 'noted' }),
    ]

    await flush(messages, context)

    expect(written).toEqual([{ fact: 'weighed 70kg', origin: 'trusted:system' }])
  })

  it('propagates an extractFacts failure so the decorator can fail closed', async () => {
    const flush = createFactFlush({
      writeFact: vi.fn(),
      extractFacts: () => {
        throw new Error('extraction backend down')
      },
    })

    await expect(flush([fromPartial({ role: 'user', content: 'hi' })], context)).rejects.toThrow(
      'extraction backend down',
    )
  })
})

describe('withPreCompactionFlush: fail-closed does not depend on the policy behaving', () => {
  it('discards the policy output when the policy swallows the flush rejection and compacts anyway', async () => {
    const swallowing: ContextPolicy = {
      enabled: true,
      async transform(messages, context) {
        try {
          await context.beforeCompact?.()
        } catch {
          // Deliberately ignores the contract and compacts regardless.
        }
        return [fromPartial<SessionMessage>({ role: 'assistant', content: 'COMPACTED' })]
      },
    }
    const input = [fromPartial<SessionMessage>({ role: 'user', content: 'keep me' })]
    const wrapped = withPreCompactionFlush(swallowing, () => {
      throw new Error('nothing could be persisted')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await wrapped.transform(input, { sessionId: 'session-1' })

    expect(result).toBe(input)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })

  it('discards the policy output when the policy starts the flush without awaiting it', async () => {
    const fireAndForget: ContextPolicy = {
      enabled: true,
      transform(messages, context) {
        void context.beforeCompact?.()?.catch(() => undefined)
        return [fromPartial<SessionMessage>({ role: 'assistant', content: 'COMPACTED' })]
      },
    }
    const input = [fromPartial<SessionMessage>({ role: 'user', content: 'keep me' })]
    const wrapped = withPreCompactionFlush(fireAndForget, async () => {
      await Promise.resolve()
      throw new Error('nothing could be persisted')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await wrapped.transform(input, { sessionId: 'session-2' })

    expect(result).toBe(input)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    errorSpy.mockRestore()
  })
})

describe('withPreCompactionFlush: the policy cannot compact by mutating the caller in place', () => {
  it('leaves the caller array intact when a policy splices it and then swallows a failed flush', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mutating: ContextPolicy = {
      enabled: true,
      async transform(messages, context) {
        try {
          await context.beforeCompact?.()
        } catch {
          // Ignores the contract, and tries to compact by mutation rather than
          // by its return value — discarding the return value alone would not
          // undo this if the wrapper had handed over the caller's own array.
        }
        messages.splice(0, messages.length, fromPartial<SessionMessage>({ content: 'COMPACTED' }))
        return messages
      },
    }
    const input: SessionMessage[] = [fromPartial({ role: 'user', content: 'keep me' })]
    const wrapped = withPreCompactionFlush(mutating, () => {
      throw new Error('nothing could be persisted')
    })

    const result = await wrapped.transform(input, { sessionId: 'session-3' })

    expect(result).toBe(input)
    expect(result).toHaveLength(1)
    expect(result[0]?.content).toBe('keep me')
    errorSpy.mockRestore()
  })
})
