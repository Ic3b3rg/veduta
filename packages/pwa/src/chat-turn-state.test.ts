import type { ChatMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  applyTurnFrame,
  interruptTurns,
  type ChatTurnFrame,
  type StreamingTurn,
} from './chat-turn-state.ts'

function turns(...entries: StreamingTurn[]): Map<string, StreamingTurn> {
  return new Map(entries.map((entry) => [entry.turnId, entry]))
}

describe('applyTurnFrame', () => {
  it('opens a new turn at empty text on chat.turn-start', () => {
    const frame: ChatTurnFrame = { type: 'chat.turn-start', turnId: 'turn-1', spaceId: 'spc-home' }

    const result = applyTurnFrame(new Map(), frame)

    expect(result.turns.get('turn-1')).toEqual({
      turnId: 'turn-1',
      spaceId: 'spc-home',
      text: '',
    })
    expect(result.completed).toBeUndefined()
  })

  it('appends chat.turn-delta fragments in order', () => {
    const started = applyTurnFrame(new Map(), {
      type: 'chat.turn-start',
      turnId: 'turn-1',
      spaceId: undefined,
    }).turns

    const afterFirst = applyTurnFrame(started, {
      type: 'chat.turn-delta',
      turnId: 'turn-1',
      spaceId: undefined,
      text: 'Hel',
    })
    const afterSecond = applyTurnFrame(afterFirst.turns, {
      type: 'chat.turn-delta',
      turnId: 'turn-1',
      spaceId: undefined,
      text: 'lo',
    })

    expect(afterSecond.turns.get('turn-1')?.text).toBe('Hello')
    expect(afterSecond.completed).toBeUndefined()
  })

  it('keeps concurrent turns independent by turnId, not a single slot', () => {
    const withGlobal = applyTurnFrame(new Map(), {
      type: 'chat.turn-start',
      turnId: 'turn-global',
      spaceId: undefined,
    }).turns
    const withBoth = applyTurnFrame(withGlobal, {
      type: 'chat.turn-start',
      turnId: 'turn-space',
      spaceId: 'spc-health',
    }).turns

    const afterGlobalDelta = applyTurnFrame(withBoth, {
      type: 'chat.turn-delta',
      turnId: 'turn-global',
      spaceId: undefined,
      text: 'A',
    })
    const afterSpaceDelta = applyTurnFrame(afterGlobalDelta.turns, {
      type: 'chat.turn-delta',
      turnId: 'turn-space',
      spaceId: 'spc-health',
      text: 'B',
    })

    expect(afterSpaceDelta.turns.get('turn-global')).toEqual({
      turnId: 'turn-global',
      spaceId: undefined,
      text: 'A',
    })
    expect(afterSpaceDelta.turns.get('turn-space')).toEqual({
      turnId: 'turn-space',
      spaceId: 'spc-health',
      text: 'B',
    })
  })

  it('removes the turn and returns the final message verbatim on chat.turn-end, not a concatenation of deltas', () => {
    const started = applyTurnFrame(new Map(), {
      type: 'chat.turn-start',
      turnId: 'turn-1',
      spaceId: undefined,
    }).turns
    const midway = applyTurnFrame(started, {
      type: 'chat.turn-delta',
      turnId: 'turn-1',
      spaceId: undefined,
      text: 'partial',
    }).turns

    const result = applyTurnFrame(midway, {
      type: 'chat.turn-end',
      turnId: 'turn-1',
      spaceId: undefined,
      message: { role: 'assistant', text: 'the complete final answer' },
    })

    expect(result.turns.has('turn-1')).toBe(false)
    expect(result.completed).toEqual({ role: 'assistant', text: 'the complete final answer' })
  })

  it('replaces streamed model text with authoritative Pending-decision state', () => {
    const midway = turns({
      turnId: 'turn-1',
      spaceId: 'spc-home',
      text: 'Done — the action succeeded.',
    })
    const message: ChatMessage = {
      role: 'assistant',
      text: 'Awaiting your decision: Send message.',
      pendingDecisions: [
        {
          id: 'approval:effect-1',
          kind: 'approval',
          summary: 'Send message',
          scope: { type: 'space', spaceId: 'spc-home' },
          allowedResolutions: ['approve', 'reject'],
          state: 'pending',
          createdAt: '2026-08-25T10:00:00.000Z',
        },
      ],
    }

    const replaced = applyTurnFrame(midway, {
      type: 'chat.turn-replace',
      turnId: 'turn-1',
      spaceId: 'spc-home',
      message,
    })
    const afterLateDelta = applyTurnFrame(replaced.turns, {
      type: 'chat.turn-delta',
      turnId: 'turn-1',
      spaceId: 'spc-home',
      text: 'Done.',
    })

    expect(afterLateDelta.turns.get('turn-1')).toMatchObject({
      text: message.text,
      replacement: message,
    })
    expect(interruptTurns(afterLateDelta.turns)).toEqual([message])
  })

  it('removes the turn and produces a readable error entry on chat.turn-error', () => {
    const started = turns({ turnId: 'turn-1', spaceId: 'spc-home', text: 'partial' })

    const result = applyTurnFrame(started, {
      type: 'chat.turn-error',
      turnId: 'turn-1',
      spaceId: 'spc-home',
      error: 'model timed out',
    })

    expect(result.turns.has('turn-1')).toBe(false)
    expect(result.completed).toEqual({
      role: 'assistant',
      text: 'Something went wrong: model timed out',
    })
  })

  it('leaves unrelated turns untouched when one turn ends', () => {
    const started = turns(
      { turnId: 'turn-1', spaceId: undefined, text: 'a' },
      { turnId: 'turn-2', spaceId: 'spc-health', text: 'b' },
    )

    const result = applyTurnFrame(started, {
      type: 'chat.turn-end',
      turnId: 'turn-1',
      spaceId: undefined,
      message: { role: 'assistant', text: 'a' },
    })

    expect(result.turns.has('turn-1')).toBe(false)
    expect(result.turns.get('turn-2')).toEqual({
      turnId: 'turn-2',
      spaceId: 'spc-health',
      text: 'b',
    })
  })
})

describe('interruptTurns', () => {
  it('turns every in-flight turn with accumulated text into a marked chat entry', () => {
    const result = interruptTurns(
      turns(
        { turnId: 'turn-1', spaceId: undefined, text: 'partial answer' },
        { turnId: 'turn-2', spaceId: 'spc-health', text: 'another partial' },
      ),
    )

    expect(result).toEqual([
      { role: 'assistant', text: 'partial answer (connection lost mid-reply)' },
      { role: 'assistant', text: 'another partial (connection lost mid-reply)' },
    ])
  })

  it('drops a turn silently when it never accumulated any visible text', () => {
    const result = interruptTurns(turns({ turnId: 'turn-1', spaceId: undefined, text: '' }))

    expect(result).toEqual([])
  })

  it('returns an empty list for an empty turns map', () => {
    expect(interruptTurns(new Map())).toEqual([])
  })
})
