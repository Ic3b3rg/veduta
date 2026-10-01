import { ActionIntentIdSchema, FastActionInvocationSchema } from '@veduta/protocol'
import { z } from 'zod'

export const AUTH_TOKEN_KEY = 'veduta.authToken'
export const HOME_CACHE_KEY = 'veduta.homeSnapshot'
export const CHAT_QUEUE_KEY = 'veduta.chatQueue'
export const FAST_ACTION_QUEUE_KEY = 'veduta.fastActionQueue'
export const SURFACE_ORDER_KEY = 'veduta.surfaceOrder'
export const INSTALL_DISMISSED_KEY = 'veduta.installDismissed'
export const NOTIF_BELL_DISMISSED_KEY = 'veduta.notifBellDismissed'

export interface QueuedChat {
  id: string
  text: string
  at: string
  spaceId?: string
  retryOf?: string
  status?: 'queued' | 'rejected'
}

export const QueuedFastActionSchema = z
  .object({
    id: ActionIntentIdSchema,
    surfaceId: z.string().min(1),
    invocation: FastActionInvocationSchema,
    at: z.string().datetime(),
    status: z.enum(['queued', 'recovery_pending']),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (record.id !== record.invocation.intentId)
      ctx.addIssue({
        code: 'custom',
        path: ['id'],
        message: 'queue identity must match the action intent',
      })
  })
export type QueuedFastAction = z.infer<typeof QueuedFastActionSchema>

export interface BrowserInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' | string }>
}

export function queuedChatEntry(
  text: string,
  spaceId: string | undefined,
  retryOf?: string,
): QueuedChat {
  const entry = { id: crypto.randomUUID(), text, at: new Date().toISOString() }
  return {
    ...entry,
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(retryOf === undefined ? {} : { retryOf }),
  }
}

export function defaultDeviceName(): string {
  return navigator.userAgent.includes('Mobile') ? 'Phone' : 'Computer'
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  )
}

export function readQueuedChat(storage: Storage = localStorage): QueuedChat[] {
  return readArray(CHAT_QUEUE_KEY, storage).filter(isQueuedChat)
}

export function persistQueuedChat(entries: QueuedChat[], storage: Storage = localStorage): void {
  storage.setItem(CHAT_QUEUE_KEY, JSON.stringify(entries))
}

export function readQueuedFastActions(storage: Storage = localStorage): QueuedFastAction[] {
  return readFastActionQueue(storage).entries
}

export function readFastActionQueue(storage: Storage = localStorage): {
  entries: QueuedFastAction[]
  invalid: boolean
} {
  let raw: unknown
  const stored = storage.getItem(FAST_ACTION_QUEUE_KEY)
  if (stored === null) return { entries: [], invalid: false }
  try {
    raw = JSON.parse(stored)
  } catch {
    return { entries: [], invalid: true }
  }
  if (!Array.isArray(raw)) return { entries: [], invalid: true }
  const entries = raw.flatMap((value) => {
    const parsed = QueuedFastActionSchema.safeParse(value)
    return parsed.success ? [parsed.data] : []
  })
  const unique = new Map<string, QueuedFastAction>()
  const conflicts = new Set<string>()
  for (const entry of entries) {
    const previous = unique.get(entry.id)
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) conflicts.add(entry.id)
    unique.set(entry.id, entry)
  }
  for (const id of conflicts) unique.delete(id)
  return { entries: [...unique.values()], invalid: unique.size !== raw.length }
}

export function persistQueuedFastActions(
  entries: QueuedFastAction[],
  storage: Storage = localStorage,
): void {
  storage.setItem(FAST_ACTION_QUEUE_KEY, JSON.stringify(entries))
}

function readArray(key: string, storage: Storage): unknown[] {
  const raw = storage.getItem(key)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function isQueuedChat(value: unknown): value is QueuedChat {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['at'] === 'string' &&
    (value['spaceId'] === undefined || typeof value['spaceId'] === 'string') &&
    (value['retryOf'] === undefined || typeof value['retryOf'] === 'string') &&
    (value['status'] === undefined ||
      value['status'] === 'queued' ||
      value['status'] === 'rejected')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
