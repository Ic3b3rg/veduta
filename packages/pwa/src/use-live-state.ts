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
