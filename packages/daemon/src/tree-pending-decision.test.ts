import type { PendingDecisionLifecycleMessage, Surface } from '@veduta/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'
import { TreePendingDecisionAdapter } from './tree-pending-decision.ts'
import { TreeProposalSurfaceManager } from './tree-proposal.ts'
import { PendingDecisionService } from './pending-decision-service.ts'
import { startPendingDecisionLifecycle } from './pending-decision-lifecycle.ts'

const roots: string[] = []
const fixedNow = () => new Date('2026-08-16T08:00:00.000Z')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TreePendingDecisionAdapter', () => {
  it.each(['stale', 'archived'] as const)(
    'withdraws Chat acceptance through the live decision stream when the target is %s',
    async (condition) => {
      const rootDir = mkdtempSync(join(tmpdir(), 'veduta-tree-decision-live-'))
      roots.push(rootDir)
      const store = new Store({ rootDir, now: fixedNow })
      const manager = new TreeProposalSurfaceManager({ store })
      const surfaceId = 'srf-tree-live'
      const proposalId = createProposal(store, surfaceId)
      const id = `tree-proposal:${proposalId}`
      const adapter = new TreePendingDecisionAdapter(store, manager)
      const decisions = new PendingDecisionService({ adapters: [adapter] })
      const updates: Omit<PendingDecisionLifecycleMessage, 'type'>[] = []
      const stopLifecycle = startPendingDecisionLifecycle({
        decisions,
        store,
        trust: { onChange: () => () => {} },
        gateway: { broadcastPendingDecision: (update) => updates.push(update) },
      })
      try {
        await decisions.refresh()
        expect(adapter.get(id)?.allowedResolutions).toEqual(['accept', 'reject'])
        if (condition === 'archived') {
          store.archiveSurface(surfaceId, 'user')
        } else {
          store.patchTree(
            surfaceId,
            [
              {
                target: 'tree',
                op: 'replace',
                path: '/children/0',
                value: { id: 'title', type: 'Title', props: { text: 'Changed plan' } },
              },
            ],
            {
              expectedTreeVersion: store.getSurfaceVersion(surfaceId)!.treeVersion,
              updatedBy: 'user',
              bypassPin: true,
            },
          )
        }
        await expect
          .poll(() => updates.at(-1)?.decision)
          .toMatchObject({
            id,
            state: 'pending',
            allowedResolutions: ['reject'],
          })
        const target = store.getSurface(surfaceId)
        await expect(decisions.resolve(id, 'accept', 'trusted:user')).rejects.toThrow(
          'is not allowed',
        )
        const result = await decisions.resolve(id, 'reject', 'trusted:user')
        expect(result.decision).toMatchObject({
          state: 'terminal',
          outcome: 'rejected',
          allowedResolutions: ['accept', 'reject'],
        })
        expect(store.getSurface(surfaceId)).toEqual(target)
      } finally {
        stopLifecycle()
        manager.dispose()
        store.close()
      }
    },
  )

  it('lists and resolves through the Tree-proposal manager, preserving durable actor and outcome', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-tree-decision-'))
    roots.push(rootDir)
    const store = new Store({ rootDir, now: fixedNow })
    const manager = new TreeProposalSurfaceManager({ store })
    const proposalId = createProposal(store, 'srf-tree-decision')
    const adapter = new TreePendingDecisionAdapter(store, manager)
    const id = `tree-proposal:${proposalId}`

    expect(adapter.get(id)).toEqual({
      id,
      kind: 'tree-proposal',
      summary: '“Weekly plan”: Add “Ready”',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      decisionSurfaceId: `srf-tree-proposal-${proposalId}`,
      createdAt: '2026-08-16T08:00:00.000Z',
    })

    await expect(adapter.resolve(id, 'accept', 'trusted:user')).resolves.toMatchObject({
      id,
      state: 'terminal',
      outcome: 'accepted',
      resolvedBy: 'trusted:user',
    })
    expect(store.getTreeProposal(proposalId)?.resolvedBy).toBe('trusted:user')
    expect(
      store
        .eventLog('spc-health')
        .filter((event) => event.type === 'surface.tree_proposal_accepted'),
    ).toHaveLength(1)

    manager.dispose()
    const reopenedStore = new Store({ rootDir, now: fixedNow })
    const reopenedManager = new TreeProposalSurfaceManager({ store: reopenedStore })
    reopenedManager.start()
    const reopened = new TreePendingDecisionAdapter(reopenedStore, reopenedManager)
    expect(reopened.get(id)).toMatchObject({
      state: 'terminal',
      outcome: 'accepted',
      resolvedBy: 'trusted:user',
    })
    reopenedManager.dispose()
  })

  it('delegates rejection without changing the target tree', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-tree-decision-'))
    roots.push(rootDir)
    const store = new Store({ rootDir, now: fixedNow })
    const manager = new TreeProposalSurfaceManager({ store })
    const proposalId = createProposal(store, 'srf-tree-reject')
    const before = store.getSurface('srf-tree-reject')?.tree
    const adapter = new TreePendingDecisionAdapter(store, manager)

    const decision = await adapter.resolve(`tree-proposal:${proposalId}`, 'reject', 'trusted:user')

    expect(decision).toMatchObject({ state: 'terminal', outcome: 'rejected' })
    expect(store.getSurface('srf-tree-reject')?.tree).toEqual(before)
    manager.dispose()
  })

  it('preserves the owning workflow stale-target refusal', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-tree-decision-'))
    roots.push(rootDir)
    const store = new Store({ rootDir, now: fixedNow })
    const manager = new TreeProposalSurfaceManager({ store })
    const surfaceId = 'srf-tree-stale'
    const proposalId = createProposal(store, surfaceId)
    const currentVersion = store.getSurfaceVersion(surfaceId)
    if (!currentVersion) throw new Error('expected target Surface version')
    store.patchTree(
      surfaceId,
      [
        {
          target: 'tree',
          op: 'add',
          path: '/children/1',
          value: { id: 'changed', type: 'Caption', props: { text: 'Changed' } },
        },
      ],
      {
        expectedTreeVersion: currentVersion.treeVersion,
        updatedBy: 'user',
        bypassPin: true,
        origin: 'trusted:user',
      },
    )

    const decision = await new TreePendingDecisionAdapter(store, manager).resolve(
      `tree-proposal:${proposalId}`,
      'accept',
      'trusted:user',
    )

    expect(decision).toMatchObject({
      state: 'terminal',
      outcome: 'stale',
      resolvedBy: 'trusted:user',
    })
    expect(store.getTreeProposal(proposalId)).toMatchObject({
      status: 'stale',
      resolvedBy: 'trusted:user',
    })
    expect(
      store
        .eventLog('spc-health')
        .filter((event) => event.type === 'surface.tree_proposal_accepted'),
    ).toHaveLength(0)
    manager.dispose()
  })
})

function createProposal(store: Store, surfaceId: string): number {
  store.createSurface(targetSurface(surfaceId), 'agent')
  store.setPinned(surfaceId, true, { origin: 'trusted:user', updatedBy: 'user' })
  const version = store.getSurfaceVersion(surfaceId)
  if (!version) throw new Error('expected target Surface version')
  const result = store.patchTree(
    surfaceId,
    [
      {
        target: 'tree',
        op: 'add',
        path: '/children/1',
        value: { id: 'note', type: 'Caption', props: { text: 'Ready' } },
      },
    ],
    { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
  )
  if (!('proposed' in result)) throw new Error('expected Tree proposal')
  return result.proposalId
}

function targetSurface(id: string): Surface {
  return {
    id,
    spaceId: 'spc-health',
    title: 'Weekly plan',
    tree: {
      id: 'root',
      type: 'Box',
      children: [{ id: 'title', type: 'Title', props: { text: 'Weekly plan' } }],
    },
    state: {},
    freshness: { updatedAt: '2026-08-16T08:00:00.000Z', updatedBy: 'agent' },
    pinned: false,
    pinnable: true,
    presentation: 'standard',
  }
}
