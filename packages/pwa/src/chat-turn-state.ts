import type { ChatMessage, GatewayServerMessage } from '@veduta/protocol'

/** One in-flight streamed Agent turn (issue 037). Keyed by `turnId` in
 * `App` rather than a single slot: a global turn and a per-Space turn can be
 * streaming concurrently, and each must accumulate its own text. */
export interface StreamingTurn {
  turnId: string
  spaceId: string | undefined
  text: string
  replacement?: ChatMessage
}

export type ChatTurnFrame = Extract<
  GatewayServerMessage,
  {
    type:
      | 'chat.turn-start'
      | 'chat.turn-delta'
      | 'chat.turn-replace'
      | 'chat.turn-end'
      | 'chat.turn-error'
  }
>

export interface ApplyTurnFrameResult {
  turns: Map<string, StreamingTurn>
  /** Set only when this frame closed the turn (`chat.turn-end` or
   * `chat.turn-error`): the entry the caller should append to the persisted
   * chat log. Delta and replacement frames never set this -- in-flight state
   * lives only in `turns`, so intermediate content never touches localStorage. */
  completed?: ChatMessage
}

/**
 * Pure reducer over the streaming-turns map: `App` owns the map in state and
 * a ref mirror (matching its `spacesRef`/`replaceSpaces` pattern elsewhere),
 * calling this on every `chat.turn-*` frame instead of branching inline.
 * `chat.turn-replace` discards streamed model text once the daemon owns a
 * Pending-decision status, and later deltas cannot overwrite that status.
 * `chat.turn-end` carries the complete final text and is NOT a concatenation
 * target -- it replaces whatever `chat.turn-delta` fragments accumulated,
 * which is why the turn is removed from `turns` and `message` is returned
 * as-is rather than merged with the accumulated text.
 */
export function applyTurnFrame(
  turns: Map<string, StreamingTurn>,
  frame: ChatTurnFrame,
): ApplyTurnFrameResult {
  switch (frame.type) {
    case 'chat.turn-start': {
      const next = new Map(turns)
      next.set(frame.turnId, { turnId: frame.turnId, spaceId: frame.spaceId, text: '' })
      return { turns: next }
    }

    case 'chat.turn-delta': {
      const existing = turns.get(frame.turnId)
      if (existing?.replacement !== undefined) return { turns }
      const next = new Map(turns)
      next.set(frame.turnId, {
        turnId: frame.turnId,
        spaceId: existing?.spaceId ?? frame.spaceId,
        text: (existing?.text ?? '') + frame.text,
      })
      return { turns: next }
    }

    case 'chat.turn-replace': {
      const next = new Map(turns)
      const existing = next.get(frame.turnId)
      next.set(frame.turnId, {
        turnId: frame.turnId,
        spaceId: existing?.spaceId ?? frame.spaceId,
        text: frame.message.text,
        replacement: frame.message,
      })
      return { turns: next }
    }

    case 'chat.turn-end': {
      const next = new Map(turns)
      next.delete(frame.turnId)
      return { turns: next, completed: frame.message }
    }

    case 'chat.turn-error': {
      const next = new Map(turns)
      next.delete(frame.turnId)
      return {
        turns: next,
        completed: { role: 'assistant', text: `Something went wrong: ${frame.error}` },
      }
    }
  }
}

/**
 * Called when the Gateway socket closes mid-turn (issue 037): a disconnect
 * mid-reply must not leave a ghost "streaming" entry forever, nor silently
 * drop whatever text had already arrived. An authoritative replacement is
 * preserved verbatim; every other in-flight turn becomes a terminal chat
 * entry from its accumulated text, with a note that the reply was cut short.
 * A turn that never accumulated any visible text (dropped before its first
 * delta) is dropped silently rather than turned into an empty chat bubble.
 */
export function interruptTurns(turns: Map<string, StreamingTurn>): ChatMessage[] {
  const completed: ChatMessage[] = []
  for (const turn of turns.values()) {
    if (turn.replacement !== undefined) {
      completed.push(turn.replacement)
      continue
    }
    if (turn.text.length === 0) continue
    completed.push({ role: 'assistant', text: `${turn.text} (connection lost mid-reply)` })
  }
  return completed
}
