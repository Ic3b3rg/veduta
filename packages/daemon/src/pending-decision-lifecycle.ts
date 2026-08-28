import { pendingDecisionFeedback, type PendingDecisionLifecycleMessage } from '@veduta/protocol'
import type { GatewayHub } from './gateway.ts'
import type {
  PendingDecisionLifecycleEvent,
  PendingDecisionService,
} from './pending-decision-service.ts'
import type { TrustLayer } from './trust-layer.ts'

interface SurfaceChangeSource {
  onSurfaceEvent(listener: () => void): () => void
}

interface PendingDecisionLifecycleDependencies {
  decisions: Pick<PendingDecisionService, 'refresh' | 'onLifecycle'>
  gateway: Pick<GatewayHub, 'broadcastPendingDecision'>
  trust: Pick<TrustLayer, 'onChange'>
  store: SurfaceChangeSource
}

/** Bridges workflow-owned changes to one daemon lifecycle stream and returns its cleanup. */
export function startPendingDecisionLifecycle(
  dependencies: PendingDecisionLifecycleDependencies,
): () => void {
  const refresh = () => {
    void dependencies.decisions.refresh().catch((error) => {
      console.error('Pending decision lifecycle refresh failed', error)
    })
  }
  const broadcast = ({ revision, decision }: PendingDecisionLifecycleEvent) => {
    const lifecycle: Omit<PendingDecisionLifecycleMessage, 'type'> = {
      revision,
      decision,
      message: pendingDecisionFeedback(decision),
    }
    dependencies.gateway.broadcastPendingDecision(lifecycle)
  }
  const dispose = [
    dependencies.decisions.onLifecycle(broadcast),
    dependencies.trust.onChange(refresh),
    dependencies.store.onSurfaceEvent(refresh),
  ]

  refresh()
  return () => {
    for (const unsubscribe of dispose) unsubscribe()
  }
}
