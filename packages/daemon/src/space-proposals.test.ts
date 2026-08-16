import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  SpaceProposalConflictError,
  SpaceProposalStore,
  type SpaceProposal,
} from './space-proposals.ts'

const roots: string[] = []
const now = () => new Date('2026-08-16T08:00:00.000Z')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SpaceProposalStore', () => {
  it('persists a proposal and replays one accepted transition without repeating its effect', () => {
    const rootDir = tempRoot()
    const accepted: string[] = []
    const first = store(rootDir, (proposal) => accepted.push(proposal.id))
    const proposal = first.create(proposalInput())

    const reopened = store(rootDir, (candidate) => accepted.push(candidate.id))
    const resolved = reopened.resolve(proposal.id, 'accept', 'trusted:user')
    const replayed = reopened.resolve(proposal.id, 'reject', 'trusted:user')

    expect(resolved).toMatchObject({ status: 'accepted', resolvedBy: 'trusted:user' })
    expect(replayed).toEqual(resolved)
    expect(accepted).toEqual([proposal.id])
    expect(store(rootDir, () => accepted.push('unexpected')).get(proposal.id)).toEqual(resolved)
    expect(accepted).toEqual([proposal.id])
  })

  it('keeps partial Space creation resolving and retries it after restart', () => {
    const rootDir = tempRoot()
    const first = store(rootDir, () => {
      throw new Error('Event append interrupted')
    })
    const proposal = first.create(proposalInput())

    expect(() => first.resolve(proposal.id, 'accept', 'trusted:user')).toThrow(
      'Event append interrupted',
    )
    expect(first.get(proposal.id)).toMatchObject({ status: 'resolving' })

    const accepted: string[] = []
    const recovered = store(rootDir, (candidate) => accepted.push(candidate.id))
    expect(recovered.get(proposal.id)).toMatchObject({ status: 'accepted' })
    expect(accepted).toEqual([proposal.id])
  })

  it('terminalizes a deterministic Space identity conflict as failed', () => {
    const rootDir = tempRoot()
    const proposals = store(rootDir, () => {
      throw new SpaceProposalConflictError('conflicting Space')
    })
    const proposal = proposals.create(proposalInput())

    expect(proposals.resolve(proposal.id, 'accept', 'trusted:user')).toMatchObject({
      status: 'failed',
      resolvedBy: 'trusted:user',
    })
  })
})

function store(rootDir: string, accept: (proposal: SpaceProposal) => void): SpaceProposalStore {
  return new SpaceProposalStore({ rootDir, now, accept })
}

function proposalInput(): Pick<SpaceProposal, 'name' | 'slug' | 'spaceId' | 'reason'> {
  return {
    name: 'Home',
    slug: 'home',
    spaceId: 'spc-home',
    reason: 'User asked to track household routines.',
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'veduta-space-proposals-'))
  roots.push(root)
  return root
}
