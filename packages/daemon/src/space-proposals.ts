import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomicDurable } from './atomic-file.ts'

const SPACE_PROPOSALS_FILE = 'space-proposals.json'

export interface SpaceProposal {
  id: string
  name: string
  slug: string
  spaceId: string
  reason: string
  createdAt: string
  status: 'pending' | 'resolving' | 'accepted' | 'rejected' | 'failed'
  decisionAt?: string | undefined
  resolvedAt?: string | undefined
  resolvedBy?: 'trusted:user' | undefined
}

const SpaceProposalSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    slug: z.string().min(1),
    spaceId: z.string().min(1),
    reason: z.string(),
    createdAt: z.string().datetime(),
    status: z.enum(['pending', 'resolving', 'accepted', 'rejected', 'failed']),
    decisionAt: z.string().datetime().optional(),
    resolvedAt: z.string().datetime().optional(),
    resolvedBy: z.literal('trusted:user').optional(),
  })
  .strict()

export class SpaceProposalConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpaceProposalConflictError'
  }
}

export interface SpaceProposalStoreOptions {
  rootDir: string
  now: () => Date
  accept: (proposal: SpaceProposal) => void
}

/** Durable state machine for daemon-owned Space proposals. */
export class SpaceProposalStore {
  private readonly path: string
  private readonly now: () => Date
  private readonly accept: (proposal: SpaceProposal) => void
  private readonly proposals = new Map<string, SpaceProposal>()

  constructor(options: SpaceProposalStoreOptions) {
    this.path = join(options.rootDir, SPACE_PROPOSALS_FILE)
    this.now = options.now
    this.accept = options.accept
    this.load()
    this.recoverResolving()
  }

  create(input: Pick<SpaceProposal, 'name' | 'slug' | 'spaceId' | 'reason'>): SpaceProposal {
    const proposal = SpaceProposalSchema.parse({
      ...input,
      id: `space-proposal-${randomUUID()}`,
      createdAt: this.nowIso(),
      status: 'pending',
    })
    this.commit(proposal)
    return proposal
  }

  list(): SpaceProposal[] {
    return [...this.proposals.values()].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    )
  }

  get(proposalId: string): SpaceProposal | undefined {
    return this.proposals.get(proposalId)
  }

  reservedSlugs(): string[] {
    return this.list()
      .filter((proposal) => proposal.status === 'pending' || proposal.status === 'resolving')
      .map((proposal) => proposal.slug)
  }

  resolve(
    proposalId: string,
    resolution: 'accept' | 'reject',
    actor: 'trusted:user',
  ): SpaceProposal {
    if (actor !== 'trusted:user') throw new Error('Space proposal resolution requires trusted:user')
    const current = this.require(proposalId)
    if (current.status !== 'pending' && current.status !== 'resolving') return current
    if (current.status === 'resolving') return this.recover(current)

    const decisionAt = this.nowIso()
    if (resolution === 'reject') {
      return this.commit({
        ...current,
        status: 'rejected',
        decisionAt,
        resolvedAt: decisionAt,
        resolvedBy: actor,
      })
    }

    const resolving = this.commit({
      ...current,
      status: 'resolving',
      decisionAt,
      resolvedBy: actor,
    })
    return this.recover(resolving)
  }

  private load(): void {
    if (!existsSync(this.path)) return
    const proposals = z
      .array(SpaceProposalSchema)
      .parse(JSON.parse(readFileSync(this.path, 'utf8')))
    for (const proposal of proposals) this.proposals.set(proposal.id, proposal)
  }

  private recoverResolving(): void {
    for (const proposal of this.list()) {
      if (proposal.status === 'resolving') this.recover(proposal)
    }
  }

  private recover(proposal: SpaceProposal): SpaceProposal {
    if (proposal.status !== 'resolving') return proposal
    try {
      this.accept(proposal)
    } catch (error) {
      if (!(error instanceof SpaceProposalConflictError)) throw error
      return this.commit({ ...proposal, status: 'failed', resolvedAt: this.nowIso() })
    }
    return this.commit({ ...proposal, status: 'accepted', resolvedAt: this.nowIso() })
  }

  private commit(input: SpaceProposal): SpaceProposal {
    const proposal = SpaceProposalSchema.parse(input)
    const previous = this.proposals.get(proposal.id)
    this.proposals.set(proposal.id, proposal)
    try {
      writeJsonAtomicDurable(this.path, this.list())
    } catch (error) {
      if (previous === undefined) this.proposals.delete(proposal.id)
      else this.proposals.set(proposal.id, previous)
      throw error
    }
    return proposal
  }

  private require(proposalId: string): SpaceProposal {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) throw new Error(`unknown Space proposal: ${proposalId}`)
    return proposal
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}
