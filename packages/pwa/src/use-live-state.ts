import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import { createPwaLiveStateRuntime, type PwaLiveStateRuntime } from './pwa-live-state-runtime.ts'

export const PwaRuntimeContext = createContext<PwaLiveStateRuntime | undefined>(undefined)

/** React observes runtime authority; it owns no transport or recovery state. */
export function useLiveState() {
  const [runtime] = useState(createPwaLiveStateRuntime)
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot)
  useEffect(() => {
    void runtime.start()
    return () => runtime.stop()
  }, [runtime])
  return { runtime, snapshot }
}

export function usePwaRuntime(): PwaLiveStateRuntime | undefined {
  return useContext(PwaRuntimeContext)
}

const noSubscription = () => () => {}

/** The catalog observes local command confirmations while canonical values stay in Surface state. */
export function useActionConfirmations(surfaceId: string) {
  const runtime = usePwaRuntime()
  const read = () => runtime?.getSnapshot().actionConfirmations[surfaceId]
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read)
}

/** A remounted control observes the same runtime wait and retry status as its original instance. */
export function useActionStatuses(surfaceId: string) {
  const runtime = usePwaRuntime()
  const read = () => runtime?.getSnapshot().actionStatuses[surfaceId]
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read)
}

/** Ordering is confirmed online work, independent of the durable Atom action queues. */
export function useSurfaceOrderStatus(surfaceId: string) {
  const runtime = usePwaRuntime()
  const read = () => runtime?.getSnapshot().surfaceOrderStatuses[surfaceId]
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read)
}

export function useGatewayOnline() {
  const runtime = usePwaRuntime()
  const read = () => runtime?.getSnapshot().gatewayOnline ?? true
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read)
}
