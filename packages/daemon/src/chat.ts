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

export interface ChatReminder {
  /** What to do at the deadline, e.g. "log my weight". */
  action: string
  fireAtIso: string
  /** Dev-demo heuristic: the last word of the action as an Event log needle. */
  conditionNeedle: string
}

/**
 * Dev-profile stand-in for the Agent's arm_timer decision: "remind me
 * to <action> by <time>" arms a visible timer, proving the chat →
 * Automation flow without an API key. Times are daemon-local wall
 * clock, like the Meals Surface labels.
 */
export function reminderFromChat(text: string, at: Date): ChatReminder | undefined {
  const match = /\bremind me to\s+(.+?)\s+by\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text)
  if (!match) return undefined
  const [, rawAction, hourText, minuteText, meridiem] = match

  let hours = Number(hourText)
  if (meridiem?.toLowerCase() === 'pm' && hours < 12) hours += 12
  if (meridiem?.toLowerCase() === 'am' && hours === 12) hours = 0
  const minutes = minuteText === undefined ? 0 : Number(minuteText)
  if (hours > 23 || minutes > 59) return undefined

  const fireAt = new Date(at.getTime())
  fireAt.setHours(hours, minutes, 0, 0)
  if (fireAt.getTime() <= at.getTime()) fireAt.setDate(fireAt.getDate() + 1)

  const action = rawAction!.replace(/[.!?]+$/g, '').trim()
  const needle = action.split(/\s+/).at(-1)
  if (!action || !needle) return undefined
  return { action, fireAtIso: fireAt.toISOString(), conditionNeedle: needle }
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
