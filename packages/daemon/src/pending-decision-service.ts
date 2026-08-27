import {
  parsePendingDecisionId,
  PendingDecisionListSchema,
  PendingDecisionResolveResultSchema,
  PendingDecisionSchema,
  type PendingDecision,
  type PendingDecisionKind,
  type PendingDecisionList,
  type PendingDecisionResolution,
  type PendingDecisionResolveResult,
} from '@veduta/protocol'

export interface PendingDecisionAdapter {
  readonly kind: PendingDecisionKind
  list(): Promise<PendingDecision[]> | PendingDecision[]
  get(id: string): Promise<PendingDecision | undefined> | PendingDecision | undefined
  resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: 'trusted:user',
  ): Promise<PendingDecision> | PendingDecision
}

export interface PendingDecisionServiceOptions {
  adapters: readonly PendingDecisionAdapter[]
  ready?: Promise<unknown>
}

export interface PendingDecisionLifecycleEvent {
  revision: number
  decision: PendingDecision
}

export class PendingDecisionNotFoundError extends Error {
  constructor(readonly decisionId: string) {
    super(`unknown Pending decision: ${decisionId}`)
    this.name = 'PendingDecisionNotFoundError'
  }
}

export class PendingDecisionResolutionError extends Error {
  constructor(
    readonly decisionId: string,
    readonly resolution: PendingDecisionResolution,
  ) {
    super(`resolution "${resolution}" is not allowed for Pending decision ${decisionId}`)
    this.name = 'PendingDecisionResolutionError'
  }
}

export class PendingDecisionActorError extends Error {
  constructor() {
    super('Pending decisions can only be resolved by an explicit trusted:user action')
    this.name = 'PendingDecisionActorError'
  }
}

/**
 * Channel-neutral read/resolve authority for daemon-owned Pending decisions.
 * Adapters retain every workflow's business rules; this service only validates
 * their shared contract, routes an exact id, and coalesces concurrent callers.
 */
export class PendingDecisionService {
  private readonly adapters = new Map<PendingDecisionKind, PendingDecisionAdapter>()
  private readonly ready: Promise<unknown>
  private readonly inFlight = new Map<string, Promise<PendingDecision>>()
  private readonly lifecycleListeners = new Set<(event: PendingDecisionLifecycleEvent) => void>()
  private decisions = new Map<string, PendingDecision>()
  private revision = 0
  private initialized = false
  private refreshTail: Promise<void> = Promise.resolve()

  constructor(options: PendingDecisionServiceOptions) {
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.kind)) {
        throw new Error(`duplicate Pending decision adapter for kind ${adapter.kind}`)
      }
      this.adapters.set(adapter.kind, adapter)
    }
    this.ready = options.ready ?? Promise.resolve()
  }

  async list(): Promise<PendingDecisionList> {
    await this.refresh()
    return PendingDecisionListSchema.parse({
      revision: this.revision,
      decisions: this.sortedDecisions(),
    })
  }

  /** Reconciles workflow-owned state and publishes each changed decision exactly once. */
  refresh(): Promise<void> {
    const refresh = this.refreshTail.then(() => this.collectAndPublish())
    this.refreshTail = refresh.catch(() => undefined)
    return refresh
  }

  onLifecycle(listener: (event: PendingDecisionLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => this.lifecycleListeners.delete(listener)
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: string,
  ): Promise<PendingDecisionResolveResult> {
    if (actor !== 'trusted:user') throw new PendingDecisionActorError()
    await this.refresh()

    const adapter = this.adapterForId(id)
    const current = await adapter.get(id)
    if (!current) throw new PendingDecisionNotFoundError(id)
    const parsedCurrent = this.parseAdapterDecision(current, adapter.kind, id)
    if (!parsedCurrent.allowedResolutions.includes(resolution)) {
      throw new PendingDecisionResolutionError(id, resolution)
    }
    if (parsedCurrent.state === 'terminal') {
      return PendingDecisionResolveResultSchema.parse({ decision: parsedCurrent, replayed: true })
    }

    const existing = this.inFlight.get(id)
    if (existing) {
      const decision = await existing
      return PendingDecisionResolveResultSchema.parse({ decision, replayed: true })
    }

    const work = Promise.resolve(adapter.resolve(id, resolution, actor)).then(
      async (decision) => {
        const parsed = this.parseAdapterDecision(decision, adapter.kind, id)
        await this.refresh()
        return parsed
      },
      async (error: unknown) => {
        await this.refresh()
        throw error
      },
    )
    this.inFlight.set(id, work)
    try {
      const decision = await work
      return PendingDecisionResolveResultSchema.parse({ decision, replayed: false })
    } finally {
      if (this.inFlight.get(id) === work) this.inFlight.delete(id)
    }
  }

  private async collectAndPublish(): Promise<void> {
    await this.ready
    const collected = (
      await Promise.all([...this.adapters.values()].map((adapter) => adapter.list()))
    )
      .flat()
      .map((decision) => this.parseAdapterDecision(decision))
    const next = new Map(collected.map((decision) => [decision.id, decision]))

    if (!this.initialized) {
      this.decisions = next
      this.initialized = true
      return
    }

    for (const decision of collected) {
      const previous = this.decisions.get(decision.id)
      if (previous !== undefined && decisionsEqual(previous, decision)) continue
      this.revision += 1
      this.publishLifecycle({ revision: this.revision, decision })
    }
    this.decisions = next
  }

  private publishLifecycle(event: PendingDecisionLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('Pending decision lifecycle observer failed', error)
      }
    }
  }

  private sortedDecisions(): PendingDecision[] {
    return [...this.decisions.values()].sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    )
  }

  private adapterForId(id: string): PendingDecisionAdapter {
    const parsed = parsePendingDecisionId(id)
    const adapter = parsed === undefined ? undefined : this.adapters.get(parsed.kind)
    if (!adapter) throw new PendingDecisionNotFoundError(id)
    return adapter
  }

  private parseAdapterDecision(
    input: PendingDecision,
    expectedKind?: PendingDecisionKind,
    expectedId?: string,
  ): PendingDecision {
    const decision = PendingDecisionSchema.parse(input)
    if (expectedKind !== undefined && decision.kind !== expectedKind) {
      throw new Error(
        `Pending decision adapter ${expectedKind} returned decision kind ${decision.kind}`,
      )
    }
    if (expectedId !== undefined && decision.id !== expectedId) {
      throw new Error(
        `Pending decision adapter returned ${decision.id} while resolving ${expectedId}`,
      )
    }
    return decision
  }
}

function decisionsEqual(left: PendingDecision, right: PendingDecision): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}
