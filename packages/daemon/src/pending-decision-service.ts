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
    await this.ready
    const decisions = (
      await Promise.all([...this.adapters.values()].map((adapter) => adapter.list()))
    )
      .flat()
      .map((decision) => this.parseAdapterDecision(decision))
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
      )
    return PendingDecisionListSchema.parse({ decisions })
  }

  async resolve(
    id: string,
    resolution: PendingDecisionResolution,
    actor: string,
  ): Promise<PendingDecisionResolveResult> {
    if (actor !== 'trusted:user') throw new PendingDecisionActorError()
    await this.ready

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

    const work = Promise.resolve(adapter.resolve(id, resolution, actor)).then((decision) =>
      this.parseAdapterDecision(decision, adapter.kind, id),
    )
    this.inFlight.set(id, work)
    try {
      const decision = await work
      return PendingDecisionResolveResultSchema.parse({ decision, replayed: false })
    } finally {
      if (this.inFlight.get(id) === work) this.inFlight.delete(id)
    }
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
