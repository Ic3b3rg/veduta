import type {
  AutomationOutcomeNotification,
  AutomationOutcomeNotificationLifecycleMessage,
} from '@veduta/protocol'
import { useCallback, useRef, useState } from 'react'
import {
  ApiResponseError,
  dismissAutomationOutcomeNotification,
  fetchAutomationOutcomeNotifications,
  openAutomationOutcomeNotification,
} from './api.ts'

interface AutomationOutcomeNotificationSyncOptions {
  authToken: string | undefined
  spaceId: string | undefined
  focusKey: string
  onOpenSurface: (href: string) => void
  onUnauthorized: () => void
  onError: (message: string) => void
}

export function useAutomationOutcomeNotificationSync(
  options: AutomationOutcomeNotificationSyncOptions,
) {
  const { authToken, spaceId, focusKey, onOpenSurface, onUnauthorized, onError } = options
  const [notifications, setNotifications] = useState<AutomationOutcomeNotification[]>([])
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(new Set())
  const spaceIdRef = useRef(spaceId)
  spaceIdRef.current = spaceId
  const focusKeyRef = useRef(focusKey)
  focusKeyRef.current = focusKey
  const revisionsRef = useRef(new Map<string, number>())
  const syncingRef = useRef(false)
  const generationRef = useRef(0)
  const connectionEpochRef = useRef(0)
  const bufferRef = useRef<AutomationOutcomeNotificationLifecycleMessage[]>([])

  const acceptLifecycle = useCallback(
    (lifecycle: AutomationOutcomeNotificationLifecycleMessage) => {
      const currentSpaceId = spaceIdRef.current
      if (lifecycle.notification.spaceId !== currentSpaceId || currentSpaceId === undefined) return
      const currentRevision = revisionsRef.current.get(currentSpaceId) ?? -1
      if (lifecycle.revision <= currentRevision) return
      revisionsRef.current.set(currentSpaceId, lifecycle.revision)
      setNotifications((current) => applyLifecycle(current, lifecycle.notification))
    },
    [],
  )

  const handleLifecycle = useCallback(
    (lifecycle: AutomationOutcomeNotificationLifecycleMessage) => {
      if (lifecycle.notification.spaceId !== spaceIdRef.current) return
      if (syncingRef.current) {
        bufferRef.current.push(lifecycle)
        return
      }
      acceptLifecycle(lifecycle)
    },
    [acceptLifecycle],
  )

  const beginConnection = useCallback(() => {
    connectionEpochRef.current += 1
    const connectionEpoch = connectionEpochRef.current
    generationRef.current += 1
    syncingRef.current = false
    bufferRef.current = []
    revisionsRef.current.clear()
    setNotifications([])
    setPendingIds(new Set())
    return (lifecycle: AutomationOutcomeNotificationLifecycleMessage) => {
      if (connectionEpoch !== connectionEpochRef.current) return
      handleLifecycle(lifecycle)
    }
  }, [handleLifecycle])

  const acceptConfirmedAction = useCallback((notification: AutomationOutcomeNotification) => {
    if (notification.spaceId !== spaceIdRef.current) return false
    const currentRevision = revisionsRef.current.get(notification.spaceId) ?? -1
    revisionsRef.current.set(notification.spaceId, Math.max(currentRevision, notification.revision))
    setNotifications((current) => applyLifecycle(current, notification))
    return true
  }, [])

  const refresh = useCallback((): Promise<void> => {
    generationRef.current += 1
    const generation = generationRef.current
    syncingRef.current = true
    bufferRef.current = []
    if (spaceId === undefined) {
      syncingRef.current = false
      setNotifications([])
      return Promise.resolve()
    }
    setNotifications((current) =>
      current.every((notification) => notification.spaceId === spaceId) ? current : [],
    )

    const replay = () => {
      const buffered = bufferRef.current
        .slice()
        .sort((left, right) => left.revision - right.revision)
      bufferRef.current = []
      syncingRef.current = false
      for (const lifecycle of buffered) acceptLifecycle(lifecycle)
    }

    return fetchAutomationOutcomeNotifications(spaceId, authToken).then(
      (snapshot) => {
        if (generation !== generationRef.current) return
        const currentRevision = revisionsRef.current.get(spaceId) ?? -1
        if (snapshot.revision < currentRevision) {
          replay()
          return
        }
        revisionsRef.current.set(spaceId, snapshot.revision)
        setNotifications(snapshot.notifications)
        replay()
      },
      (error: unknown) => {
        if (generation !== generationRef.current) return
        if (error instanceof ApiResponseError && error.status === 401) {
          syncingRef.current = false
          bufferRef.current = []
          onUnauthorized()
          return
        }
        onError(error instanceof Error ? error.message : String(error))
        replay()
      },
    )
  }, [acceptLifecycle, authToken, onError, onUnauthorized, spaceId])

  const cancel = useCallback(() => {
    generationRef.current += 1
    syncingRef.current = false
    bufferRef.current = []
  }, [])

  const runAction = useCallback(
    async (notification: AutomationOutcomeNotification, action: 'open' | 'dismiss') => {
      const requestedFocusKey = focusKeyRef.current
      const requestedConnectionEpoch = connectionEpochRef.current
      setPendingIds((current) => new Set(current).add(notification.id))
      try {
        const result = await (action === 'open'
          ? openAutomationOutcomeNotification(notification.spaceId, notification.id, authToken)
          : dismissAutomationOutcomeNotification(notification.spaceId, notification.id, authToken))
        if (requestedConnectionEpoch !== connectionEpochRef.current) return
        const accepted = acceptConfirmedAction(result.notification)
        if (
          accepted &&
          action === 'open' &&
          result.notification.state === 'opened' &&
          requestedFocusKey === focusKeyRef.current
        ) {
          onOpenSurface(result.notification.href)
        }
      } catch (error) {
        if (requestedConnectionEpoch !== connectionEpochRef.current) return
        if (error instanceof ApiResponseError && error.status === 401) onUnauthorized()
        else onError(error instanceof Error ? error.message : String(error))
      } finally {
        if (requestedConnectionEpoch === connectionEpochRef.current) {
          setPendingIds((current) => {
            const next = new Set(current)
            next.delete(notification.id)
            return next
          })
        }
      }
    },
    [acceptConfirmedAction, authToken, onError, onOpenSurface, onUnauthorized],
  )

  return {
    notifications: notifications.filter((notification) => notification.spaceId === spaceId),
    pendingIds,
    handleLifecycle,
    beginConnection,
    refresh,
    cancel,
    open: (notification: AutomationOutcomeNotification) => runAction(notification, 'open'),
    dismiss: (notification: AutomationOutcomeNotification) => runAction(notification, 'dismiss'),
  }
}

function applyLifecycle(
  current: readonly AutomationOutcomeNotification[],
  notification: AutomationOutcomeNotification,
): AutomationOutcomeNotification[] {
  const next = current.filter((candidate) => candidate.id !== notification.id)
  if (notification.state === 'unread') next.push(notification)
  return next.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
  )
}
