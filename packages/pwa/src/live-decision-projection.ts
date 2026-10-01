import {
  pendingDecisionFeedback,
  type ChatMessage,
  type PendingDecision,
  type PendingDecisionLifecycleMessage,
  type PendingDecisionResolution,
} from '@veduta/protocol'
import type * as Api from './api.ts'
import {
  applyPendingDecisionFeedback,
  mergePendingDecisionProjection,
  reconcilePendingDecisionSnapshot,
} from './pending-decision-state.ts'

/** Internal Pending-decision snapshot and lifecycle reconciliation, owned by the live runtime. */
export class LiveDecisionProjection {
  decisions: PendingDecision[] = []
  resolvingIds: string[] = []
  private revision = -1
  private generation = 0
  private syncing = false
  private buffer: PendingDecisionLifecycleMessage[] = []
  private projectedDuringSync: PendingDecision[] = []

  constructor(
    private readonly owner: {
      api: Pick<typeof Api, 'fetchPendingDecisions' | 'resolvePendingDecision'>
      token: () => string | undefined
      publish: () => void
      feedback: (update: (entries: ChatMessage[]) => ChatMessage[]) => void
      refreshSpaces: () => Promise<void>
      failed: (error: unknown) => void
    },
  ) {}

  cancel(): void {
    this.generation += 1
    this.syncing = false
    this.buffer = []
    this.projectedDuringSync = []
    this.resolvingIds = []
  }

  observe(decisions: readonly PendingDecision[]): void {
    if (this.syncing)
      this.projectedDuringSync = mergePendingDecisionProjection(this.projectedDuringSync, decisions)
    this.decisions = mergePendingDecisionProjection(this.decisions, decisions)
  }

  accept(lifecycle: PendingDecisionLifecycleMessage): void {
    if (this.syncing) {
      this.buffer.push(lifecycle)
      return
    }
    if (lifecycle.revision <= this.revision) return
    this.revision = lifecycle.revision
    this.observe([lifecycle.decision])
    this.owner.feedback((entries) => applyPendingDecisionFeedback(entries, lifecycle))
    this.owner.publish()
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation
    this.syncing = true
    this.buffer = []
    this.projectedDuringSync = []
    try {
      const snapshot = await this.owner.api.fetchPendingDecisions(this.owner.token())
      if (generation !== this.generation) return
      this.revision = snapshot.revision
      this.decisions = mergePendingDecisionProjection(snapshot.decisions, this.projectedDuringSync)
      this.owner.feedback((entries) => reconcilePendingDecisionSnapshot(entries, this.decisions))
    } catch (error) {
      if (generation !== this.generation) return
      this.owner.failed(error)
    }
    if (generation !== this.generation) return
    const buffered = this.buffer.sort((left, right) => left.revision - right.revision)
    this.buffer = []
    this.projectedDuringSync = []
    this.syncing = false
    for (const lifecycle of buffered) this.accept(lifecycle)
    this.owner.publish()
  }

  async resolve(id: string, resolution: PendingDecisionResolution): Promise<void> {
    if (this.resolvingIds.includes(id)) return
    const generation = this.generation
    this.resolvingIds = [...this.resolvingIds, id]
    this.owner.publish()
    try {
      const { decision } = await this.owner.api.resolvePendingDecision(
        id,
        resolution,
        this.owner.token(),
      )
      if (generation !== this.generation) return
      this.observe([decision])
      this.owner.feedback((entries) =>
        applyPendingDecisionFeedback(entries, {
          decision,
          message: pendingDecisionFeedback(decision),
        }),
      )
      if (decision.kind === 'space-proposal' && decision.outcome === 'accepted')
        await this.owner.refreshSpaces()
    } catch (error) {
      if (generation === this.generation) this.owner.failed(error)
    } finally {
      if (generation === this.generation) {
        this.resolvingIds = this.resolvingIds.filter((candidate) => candidate !== id)
        this.owner.publish()
      }
    }
  }
}
