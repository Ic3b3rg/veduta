import type { ChatMessage, JsonObject, JsonValue, PatchOperation } from '@veduta/protocol'
import { mockReply } from './mock-provider.ts'

export function handleChatText(text: string, history: ChatMessage[]): ChatMessage {
  history.push({ role: 'user', text })
  const reply: ChatMessage = { role: 'assistant', text: mockReply(history) }
  history.push(reply)
  return reply
}

export function mealPatchFromChat(
  text: string,
  state: JsonObject,
  at: Date,
): PatchOperation[] | undefined {
  const meal = mealFromText(text)
  if (!meal) return undefined

  const existing = Array.isArray(state['meals']) ? state['meals'].filter(isJsonObject) : []
  const meals = [{ time: timeLabel(at), meal }, ...existing].slice(0, 20)
  // Counted apart from the display list, which is truncated to 20 entries.
  const count = typeof state['mealCount'] === 'number' ? state['mealCount'] + 1 : meals.length

  return [
    { target: 'state', op: 'replace', path: '/meals', value: meals },
    { target: 'state', op: 'replace', path: '/lastMeal', value: meal },
    { target: 'state', op: 'replace', path: '/mealCount', value: count },
  ]
}

function mealFromText(text: string): string | undefined {
  const match = /\bi\s+ate\s+(.+)$/i.exec(text.trim())
  const meal = match?.[1]?.replace(/[.!?]+$/g, '').trim()
  return meal || undefined
}

// Daemon-local wall-clock time: the Surface shows "when I ate", not UTC.
function timeLabel(at: Date): string {
  return at.toTimeString().slice(0, 5)
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
