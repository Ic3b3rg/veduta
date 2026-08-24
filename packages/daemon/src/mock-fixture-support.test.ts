import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import { textIn, toolCallIn } from './mock-chat-model.test-helpers.ts'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import type { PiChatContext } from './pi-provider-bridge.ts'

type PiTurnMessage = PiChatContext['messages'][number]
type PiToolResultMessage = Extract<PiTurnMessage, { role: 'toolResult' }>

describe('mock fixture support', () => {
  it('builds one assistant message containing text and a tool call', () => {
    const message = toolCallMessage('read_surface', { surfaceId: 'surface-1' }, 'Reading it.')

    expect(message.stopReason).toBe('toolUse')
    expect(textIn(message)).toBe('Reading it.')
    expect(toolCallIn(message)).toMatchObject({
      name: 'read_surface',
      arguments: { surfaceId: 'surface-1' },
    })
  })

  it('joins every text block in a tool result', () => {
    const message = fromPartial<PiToolResultMessage>({
      role: 'toolResult',
      content: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
    })

    expect(toolResultText(message)).toBe('first\nsecond')
  })

  it('parses valid JSON and rejects malformed JSON', () => {
    expect(parseJson('{"valid":true}')).toEqual({ valid: true })
    expect(parseJson('{"broken"')).toBeUndefined()
  })

  it('recognizes records without accepting null or arrays', () => {
    expect(isRecord({ value: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord([])).toBe(false)
  })
})
