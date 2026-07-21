import { ChatMessageSchema, type ChatMessage, type JsonValue } from '@veduta/protocol'

export const AUTH_TOKEN_KEY = 'veduta.authToken'
export const HOME_CACHE_KEY = 'veduta.homeSnapshot'
export const CHAT_HISTORY_KEY = 'veduta.chatHistory'
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
}

export interface QueuedFastAction {
  id: string
  surfaceId: string
  nodeId: string
  actionName: string
  value: JsonValue
  idempotencyKey: string
  at: string
}

export interface BrowserInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' | string }>
}

export function queuedChatEntry(text: string, spaceId: string | undefined): QueuedChat {
  const entry = { id: crypto.randomUUID(), text, at: new Date().toISOString() }
  return spaceId === undefined ? entry : { ...entry, spaceId }
}

export function readSetupCode(): string {
  return new URLSearchParams(location.search).get('code') ?? ''
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

export function readChatHistory(): ChatMessage[] {
  const raw = localStorage.getItem(CHAT_HISTORY_KEY)
  if (!raw) return []
  try {
    const parsed = ChatMessageSchema.array().safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

export const CHAT_HISTORY_LIMIT = 80

export function persistChatHistory(entries: ChatMessage[]): void {
  localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(entries.slice(-CHAT_HISTORY_LIMIT)))
}

export function readQueuedChat(): QueuedChat[] {
  return readArray(CHAT_QUEUE_KEY).filter(isQueuedChat)
}

export function persistQueuedChat(entries: QueuedChat[]): void {
  localStorage.setItem(CHAT_QUEUE_KEY, JSON.stringify(entries))
}

export function readQueuedFastActions(): QueuedFastAction[] {
  return readArray(FAST_ACTION_QUEUE_KEY).filter(isQueuedFastAction)
}

export function persistQueuedFastActions(entries: QueuedFastAction[]): void {
  localStorage.setItem(FAST_ACTION_QUEUE_KEY, JSON.stringify(entries))
}

export function persistSurfaceOrders(orders: Record<string, string[]>): void {
  localStorage.setItem(SURFACE_ORDER_KEY, JSON.stringify(orders))
}

export function readSurfaceOrders(): Record<string, string[]> {
  const raw = localStorage.getItem(SURFACE_ORDER_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([spaceId, value]) =>
        Array.isArray(value) && value.every((id) => typeof id === 'string')
          ? [[spaceId, value]]
          : [],
      ),
    )
  } catch {
    return {}
  }
}

function readArray(key: string): unknown[] {
  const raw = localStorage.getItem(key)
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
    (value['spaceId'] === undefined || typeof value['spaceId'] === 'string')
  )
}

function isQueuedFastAction(value: unknown): value is QueuedFastAction {
  return (
    isRecord(value) &&
    typeof value['id'] === 'string' &&
    typeof value['surfaceId'] === 'string' &&
    typeof value['nodeId'] === 'string' &&
    typeof value['actionName'] === 'string' &&
    typeof value['idempotencyKey'] === 'string' &&
    typeof value['at'] === 'string' &&
    'value' in value
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
