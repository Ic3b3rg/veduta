import type {
  GmailConnectionsSnapshot,
  HimalayaConnectionsSnapshot,
  ServiceConnectionsSnapshot,
} from '@veduta/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  completeGmailAuthorization,
  failGmailAuthorization,
  fetchGmailConnections,
} from './gmail-connections-api.ts'
import { fetchHimalayaConnections } from './himalaya-connections-api.ts'
import { completeServiceGmailCallback, fetchServiceConnections } from './service-connections-api.ts'

export function useConnectionsController(token?: string) {
  const [services, setServices] = useState<ServiceConnectionsSnapshot>()
  const [gmail, setGmail] = useState<GmailConnectionsSnapshot>()
  const [himalaya, setHimalaya] = useState<HimalayaConnectionsSnapshot>()
  const [error, setError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [callbackAttemptId, setCallbackAttemptId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const active = useRef(true)
  const refreshing = useRef<Promise<void> | null>(null)
  const callbackStarted = useRef(false)
  const refresh = useCallback(async () => {
    if (refreshing.current) return refreshing.current
    const request = Promise.allSettled([
      fetchServiceConnections(token),
      fetchGmailConnections(token),
      fetchHimalayaConnections(token),
    ]).then((results) => {
      if (!active.current) return
      const [serviceResult, gmailResult, himalayaResult] = results
      if (serviceResult.status === 'fulfilled') setServices(serviceResult.value)
      if (gmailResult.status === 'fulfilled') setGmail(gmailResult.value)
      if (himalayaResult.status === 'fulfilled') setHimalaya(himalayaResult.value)
      const failure = results.find((result) => result.status === 'rejected')
      setLoadError(failure?.status === 'rejected' ? messageOf(failure.reason) : null)
    })
    refreshing.current = request
    try {
      await request
    } finally {
      if (refreshing.current === request) refreshing.current = null
    }
  }, [token])

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      if (refreshing.current) await refreshing.current
      await refresh()
      return true
    } catch (cause) {
      if (refreshing.current) await refreshing.current
      await refresh()
      if (active.current) setError(messageOf(cause))
      return false
    } finally {
      if (active.current) setBusy(false)
    }
  }

  useEffect(() => {
    active.current = true
    void refresh()
    const interval = window.setInterval(() => void refresh(), 5000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      active.current = false
      window.clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const state = params.get('state')
    if (callbackStarted.current || !state || (!params.has('code') && !params.has('error'))) return
    callbackStarted.current = true
    const code = params.get('code'),
      error = params.get('error')
    for (const key of ['code', 'state', 'error', 'scope', 'authuser', 'prompt']) params.delete(key)
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${params.size ? `?${params}` : ''}`,
    )
    void run(async () => {
      const snapshot = await fetchServiceConnections(token)
      const gmailId = state.split('.')[0] ?? ''
      const attempt =
        snapshot.attempts
          .filter(
            (item) =>
              item.connectionId === gmailId && ['authorizing', 'verifying'].includes(item.state),
          )
          .at(-1) ?? snapshot.attempts.filter((item) => item.connectionId === gmailId).at(-1)
      if (window.location.pathname !== '/app/settings/gmail' && attempt) {
        setCallbackAttemptId(attempt.id)
        await completeServiceGmailCallback(
          { state, ...(code ? { code } : {}), ...(error ? { error } : {}) },
          token,
        )
      } else if (error)
        await failGmailAuthorization(
          gmailId,
          state,
          error === 'access_denied' ? 'access_denied' : 'other',
          token,
        )
      else if (code) await completeGmailAuthorization(gmailId, code, state, token)
    })
  })

  const acknowledgeCallback = useCallback(() => setCallbackAttemptId(undefined), [])
  const clearError = useCallback(() => setError(null), [])
  return {
    services,
    gmail,
    himalaya,
    busy,
    error: error ?? loadError,
    clearError,
    run,
    refresh,
    callbackAttemptId,
    acknowledgeCallback,
  }
}

export type ConnectionsController = ReturnType<typeof useConnectionsController>
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Connection request failed'
}
