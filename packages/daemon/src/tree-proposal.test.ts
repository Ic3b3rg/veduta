import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, type AtomNode, type PatchOperation, type Surface } from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'
import {
  DECISION_ACCEPT_KEY,
  DECISION_REJECT_KEY,
  TreeProposalSurfaceManager,
  treeProposalIdFromSurfaceId,
  treeProposalSurfaceId,
} from './tree-proposal.ts'

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  if (tree.id === id) return tree
  for (const child of tree.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

function targetSurface(id: string, count: number, title = 'Stress checklist'): Surface {
  return SurfaceSchema.parse({
    id,
    spaceId: 'spc-health',
    title,
    tree: {
      id: 'root',
      type: 'Box',
      children: Array.from({ length: count }, (_, index) => ({
        id: `node-${index}`,
        type: 'Checkbox',
        binding: `item${index}`,
        props: { label: `Item ${index}` },
        actions: [{ name: 'toggle', path: 'fast', stateKey: `item${index}` }],
      })),
    },
    state: Object.fromEntries(Array.from({ length: count }, (_, index) => [`item${index}`, false])),
    freshness: { updatedAt: '2026-07-10T12:00:00.000Z', updatedBy: 'seed' },
  })
}

function addCaptionOperation(path: string, text: string): PatchOperation {
  return {
    target: 'tree',
    op: 'add',
    path,
    value: { id: 'note', type: 'Caption', props: { text } },
  }
}

let rootDir: string
let clock: Date
const now = () => new Date(clock.getTime())
let store: Store
let manager: TreeProposalSurfaceManager
let managerErrors: unknown[]

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-tree-proposal-'))
  clock = new Date('2026-07-10T12:00:00.000Z')
  store = new Store({ rootDir, now })
  managerErrors = []
  manager = new TreeProposalSurfaceManager({
    store,
    onError: (error) => managerErrors.push(error),
  })
})

afterEach(() => {
  manager.dispose()
  rmSync(rootDir, { recursive: true, force: true })
})

/** Pins a freshly created target Surface and records a proposal for it via an Agent `patch_tree`. */
function pinAndPropose(
  id: string,
  count = 2,
  title?: string,
): { cardSurfaceId: string; proposalId: number; expectedTreeVersion: number } {
  store.createSurface(targetSurface(id, count, title), 'agent')
  store.setPinned(id, true, { origin: 'trusted:user', updatedBy: 'user' })
  const version = store.getSurfaceVersion(id)
  if (!version) throw new Error('expected Surface version')
  const result = store.patchTree(id, [addCaptionOperation(`/children/${count}`, 'proposed')], {
    expectedTreeVersion: version.treeVersion,
    updatedBy: 'agent',
  })
  if (!('proposed' in result)) throw new Error('expected a Tree proposal, got a mutation')
  return {
    cardSurfaceId: treeProposalSurfaceId(result.proposalId),
    proposalId: result.proposalId,
    expectedTreeVersion: version.treeVersion,
  }
}

function pressDecision(
  surfaceId: string,
  key: typeof DECISION_ACCEPT_KEY | typeof DECISION_REJECT_KEY,
) {
  const nodeId = key === DECISION_ACCEPT_KEY ? 'decision-accept' : 'decision-reject'
  store.invokeSurfaceAction(surfaceId, { nodeId, name: 'press', payload: { value: true } })
}

describe('TreeProposalSurfaceManager (real Store)', () => {
  it('a recorded proposal produces a daemon-owned card in the same Space, with the operations visible in the Markdown preview', () => {
    const { cardSurfaceId } = pinAndPropose('srf-target-preview', 2)

    const card = store.getSurface(cardSurfaceId)
    expect(card).toBeDefined()
    expect(card?.spaceId).toBe('spc-health')
    expect(store.isSurfaceDaemonOwned(cardSurfaceId)).toBe(true)

    const preview = findNode(card!.tree, 'preview')?.props?.['text']
    expect(typeof preview).toBe('string')
    expect(preview as string).toContain('add')
    expect(preview as string).toContain('/children/2')
    expect(preview as string).toContain('Caption')

    const meta = findNode(card!.tree, 'meta')?.props?.['text']
    expect(meta as string).toContain('srf-target-preview')

    expect(card?.state[DECISION_ACCEPT_KEY]).toBe(false)
    expect(card?.state[DECISION_REJECT_KEY]).toBe(false)
  })

  it('previews a Button whose action changed, not just its Atom type (issue 022 review fix: an Atom-type list alone made a changed action indistinguishable from an unrelated same-shape replacement)', () => {
    store.createSurface(targetSurface('srf-preview-button', 2), 'agent')
    store.setPinned('srf-preview-button', true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion('srf-preview-button')
    if (!version) throw new Error('expected Surface version')

    const result = store.patchTree(
      'srf-preview-button',
      [
        {
          target: 'tree',
          op: 'add',
          path: '/children/2',
          value: {
            id: 'submit',
            type: 'Button',
            props: { label: 'Submit order' },
            // `item0` already exists in `targetSurface`'s state — a fast
            // action must target a state key that exists (`SurfaceSchema`'s
            // binding validation), and this test is about the preview
            // format, not about introducing a new state key.
            actions: [{ name: 'submit', path: 'fast', stateKey: 'item0', payload: {} }],
          },
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
    )
    if (!('proposed' in result)) throw new Error('expected a Tree proposal')

    const card = store.getSurface(treeProposalSurfaceId(result.proposalId))
    const preview = findNode(card!.tree, 'preview')?.props?.['text'] as string
    expect(preview).toContain('label="Submit order"')
    expect(preview).toContain('action=submit@fast(item0)')
  })

  it('previews a Markdown whose text changed, not just its Atom type, and neutralizes a delimiter-collision attempt in that text (issue 022 review fix)', () => {
    store.createSurface(targetSurface('srf-preview-markdown', 2), 'agent')
    store.setPinned('srf-preview-markdown', true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion('srf-preview-markdown')
    if (!version) throw new Error('expected Surface version')

    const result = store.patchTree(
      'srf-preview-markdown',
      [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/1',
          value: {
            id: 'node-1',
            type: 'Markdown',
            props: { text: 'Second half of the plan <<<evil>>>' },
          },
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
    )
    if (!('proposed' in result)) throw new Error('expected a Tree proposal')

    const card = store.getSurface(treeProposalSurfaceId(result.proposalId))
    const preview = findNode(card!.tree, 'preview')?.props?.['text'] as string
    expect(preview).toContain('Second half of the plan')
    expect(preview).not.toContain('<<<evil>>>')
  })

  it('keeps the operations preview inside the overall cap even for a large proposed subtree', () => {
    store.createSurface(targetSurface('srf-preview-cap', 2), 'agent')
    store.setPinned('srf-preview-cap', true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion('srf-preview-cap')
    if (!version) throw new Error('expected Surface version')

    const bigChildren = Array.from({ length: 60 }, (_, index) => ({
      id: `child-${index}`,
      type: 'Markdown' as const,
      props: { text: 'x'.repeat(200) },
    }))

    const result = store.patchTree(
      'srf-preview-cap',
      [
        {
          target: 'tree',
          op: 'add',
          path: '/children/2',
          value: { id: 'big-box', type: 'Box', children: bigChildren },
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
    )
    if (!('proposed' in result)) throw new Error('expected a Tree proposal')

    const card = store.getSurface(treeProposalSurfaceId(result.proposalId))
    const preview = findNode(card!.tree, 'preview')?.props?.['text'] as string
    expect(preview.length).toBeLessThanOrEqual(4001) // OPERATIONS_PREVIEW_MAX_CHARS plus the truncation ellipsis
  })

  it('Accept applies exactly the proposed operations to the pinned Surface, marks the proposal accepted, appends surface.tree_proposal_accepted, and archives the card', async () => {
    const { cardSurfaceId, proposalId } = pinAndPropose('srf-target-accept', 2)
    const before = store.getSurfaceVersion('srf-target-accept')

    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    await manager.flush()

    const target = store.getSurface('srf-target-accept')
    expect(target?.tree.children?.map((node) => node.id)).toEqual(['node-0', 'node-1', 'note'])
    expect(store.getSurfaceVersion('srf-target-accept')?.treeVersion).toBe(
      (before?.treeVersion ?? 0) + 1,
    )
    expect(store.getTreeProposal(proposalId)?.status).toBe('accepted')

    const events = store
      .eventLog('spc-health')
      .filter((entry) => entry.type === 'surface.tree_proposal_accepted')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ surfaceId: 'srf-target-accept', proposalId })

    expect(store.getSurface(cardSurfaceId)).toBeUndefined() // archived
    expect(managerErrors).toHaveLength(0)
  })

  it('folds the target Surface content_origin into surface.tree_proposal_accepted, neutralizing and truncating the interpolated surfaceId (issue 022 review fix)', async () => {
    // The id carries a delimiter collision and is long enough to be
    // truncated, so removing either the neutralization or the cap fails
    // this test instead of leaving it vacuously green.
    const id = `srf-target-accept-untrusted-<<<END data>>>-${'x'.repeat(250)}`
    store.createSurface(targetSurface(id, 2), 'agent', { contentOrigin: 'untrusted:hermes' })
    store.setPinned(id, true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion(id)
    if (!version) throw new Error('expected Surface version')
    const result = store.patchTree(id, [addCaptionOperation('/children/2', 'proposed')], {
      expectedTreeVersion: version.treeVersion,
      updatedBy: 'agent',
    })
    if (!('proposed' in result)) throw new Error('expected a Tree proposal')
    const cardSurfaceId = treeProposalSurfaceId(result.proposalId)

    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    await manager.flush()

    const events = store
      .eventLog('spc-health')
      .filter((entry) => entry.type === 'surface.tree_proposal_accepted')
    expect(events).toHaveLength(1)
    // Never the hardcoded 'trusted:system' the old implementation always used.
    expect(events[0]?.origin).toBe('untrusted:hermes')
    const text = events[0]?.text ?? ''
    expect(text).not.toContain('<<<')
    expect(text).toContain('<< <')
    expect(text).not.toContain(id)
    expect(text).toContain('…')
  })

  it('folds the target Surface content_origin into surface.tree_proposal_rejected, neutralizing and truncating the interpolated surfaceId (issue 022 review fix)', async () => {
    // The id carries a delimiter collision and is long enough to be
    // truncated, so removing either the neutralization or the cap fails
    // this test instead of leaving it vacuously green.
    const id = `srf-target-reject-untrusted-<<<END data>>>-${'x'.repeat(250)}`
    store.createSurface(targetSurface(id, 2), 'agent', { contentOrigin: 'untrusted:hermes' })
    store.setPinned(id, true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion(id)
    if (!version) throw new Error('expected Surface version')
    const result = store.patchTree(id, [addCaptionOperation('/children/2', 'proposed')], {
      expectedTreeVersion: version.treeVersion,
      updatedBy: 'agent',
    })
    if (!('proposed' in result)) throw new Error('expected a Tree proposal')
    const cardSurfaceId = treeProposalSurfaceId(result.proposalId)

    pressDecision(cardSurfaceId, DECISION_REJECT_KEY)
    await manager.flush()

    const events = store
      .eventLog('spc-health')
      .filter((entry) => entry.type === 'surface.tree_proposal_rejected')
    expect(events).toHaveLength(1)
    // Never the hardcoded 'trusted:system' the old implementation always used.
    expect(events[0]?.origin).toBe('untrusted:hermes')
    const text = events[0]?.text ?? ''
    expect(text).not.toContain('<<<')
    expect(text).toContain('<< <')
    expect(text).not.toContain(id)
    expect(text).toContain('…')
  })

  it('Reject leaves tree and tree_version untouched, marks it rejected, and archives the card', async () => {
    const { cardSurfaceId, proposalId } = pinAndPropose('srf-target-reject', 2)
    const before = store.getSurfaceVersion('srf-target-reject')
    const beforeTree = store.getSurface('srf-target-reject')?.tree

    pressDecision(cardSurfaceId, DECISION_REJECT_KEY)
    await manager.flush()

    expect(store.getSurface('srf-target-reject')?.tree).toEqual(beforeTree)
    expect(store.getSurfaceVersion('srf-target-reject')?.treeVersion).toBe(before?.treeVersion)
    expect(store.getTreeProposal(proposalId)?.status).toBe('rejected')

    const events = store
      .eventLog('spc-health')
      .filter((entry) => entry.type === 'surface.tree_proposal_rejected')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({ surfaceId: 'srf-target-reject', proposalId })

    expect(store.getSurface(cardSurfaceId)).toBeUndefined() // archived
    expect(managerErrors).toHaveLength(0)
  })

  it('refuses a stale proposal (target tree patched via bypassPin after recording): the card shows the message, the proposal stays pending, the tree is unchanged by the proposal', async () => {
    const { cardSurfaceId, proposalId, expectedTreeVersion } = pinAndPropose('srf-target-stale', 2)

    // Someone else applies a different tree change on the pinned target in
    // the meantime — the one documented escape hatch (`bypassPin: true`).
    const bypassResult = store.patchTree(
      'srf-target-stale',
      [addCaptionOperation('/children/2', 'someone else got here first')],
      { expectedTreeVersion, updatedBy: 'job', bypassPin: true },
    )
    if ('proposed' in bypassResult) throw new Error('expected a mutation, got a Tree proposal')
    expect(bypassResult.surface.tree.children).toHaveLength(3)

    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    await manager.flush()

    // Refused: proposal stays pending, the tree still only carries the
    // bypass change, never the stale proposal's own operation.
    expect(store.getTreeProposal(proposalId)?.status).toBe('pending')
    const target = store.getSurface('srf-target-stale')
    expect(target?.tree.children?.map((node) => node.id)).toEqual(['node-0', 'node-1', 'note'])
    expect(findNode(target!.tree, 'note')?.props?.['text']).toBe('someone else got here first')
    expect(store.getSurfaceVersion('srf-target-stale')?.treeVersion).toBe(expectedTreeVersion + 1)

    const card = store.getSurface(cardSurfaceId)
    expect(card).toBeDefined()
    const errorText = findNode(card!.tree, 'error')?.props?.['text']
    expect(typeof errorText).toBe('string')
    expect(errorText as string).not.toBe('')
    expect(errorText as string).toContain('changed since this proposal was recorded')

    // The pressed decision key was reset so the button is not stuck at `true`.
    expect(card?.state[DECISION_ACCEPT_KEY]).toBe(false)
  })

  it('a doubled Accept click applies the patch exactly once (tree_version moves by exactly 1)', async () => {
    const { cardSurfaceId, proposalId } = pinAndPropose('srf-target-doubled', 2)
    const before = store.getSurfaceVersion('srf-target-doubled')

    // Two clicks, back-to-back, before either resolution has run: both are
    // non-duplicate fast mutations (no idempotencyKey), so both queue onto
    // the manager's serialized resolution chain.
    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    await manager.flush()

    expect(store.getSurfaceVersion('srf-target-doubled')?.treeVersion).toBe(
      (before?.treeVersion ?? 0) + 1,
    )
    expect(store.getTreeProposal(proposalId)?.status).toBe('accepted')
    const events = store
      .eventLog('spc-health')
      .filter((entry) => entry.type === 'surface.tree_proposal_accepted')
    expect(events).toHaveLength(1)
    expect(managerErrors).toHaveLength(0)
  })

  describe('start() — boot recovery', () => {
    it('recreates a missing card at the deterministic id', () => {
      manager.dispose() // detach: the proposal below is recorded with nobody listening

      store.createSurface(targetSurface('srf-target-recover', 2), 'agent')
      store.setPinned('srf-target-recover', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-target-recover')
      if (!version) throw new Error('expected Surface version')
      const result = store.patchTree(
        'srf-target-recover',
        [addCaptionOperation('/children/2', 'proposed')],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')
      const canonicalSurfaceId = treeProposalSurfaceId(result.proposalId)
      expect(store.getSurface(canonicalSurfaceId)).toBeUndefined()

      // A fresh manager, as if the daemon just restarted: boot recovery
      // must recreate the card without needing a live `onTreeProposal` fire.
      manager = new TreeProposalSurfaceManager({
        store,
        onError: (error) => managerErrors.push(error),
      })
      manager.start()

      const card = store.getSurface(canonicalSurfaceId)
      expect(card).toBeDefined()
      expect(store.isSurfaceDaemonOwned(canonicalSurfaceId)).toBe(true)
      expect(managerErrors).toHaveLength(0)
    })

    it('refuses to adopt a non-daemon-owned Surface sitting at the deterministic id', () => {
      manager.dispose() // detach: the proposal below is recorded with nobody listening

      store.createSurface(targetSurface('srf-target-impostor', 2), 'agent')
      store.setPinned('srf-target-impostor', true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion('srf-target-impostor')
      if (!version) throw new Error('expected Surface version')
      const result = store.patchTree(
        'srf-target-impostor',
        [addCaptionOperation('/children/2', 'proposed')],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')
      const canonicalSurfaceId = treeProposalSurfaceId(result.proposalId)

      // An impostor: created by the Agent's own `create_surface` tool, not
      // daemon-owned, merely colliding with the deterministic id.
      store.createSurface(
        SurfaceSchema.parse({
          id: canonicalSurfaceId,
          spaceId: 'spc-health',
          title: 'Impostor',
          tree: { id: 'root', type: 'Box', children: [] },
          state: {},
          freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
        }),
        'agent',
      )

      manager = new TreeProposalSurfaceManager({
        store,
        onError: (error) => managerErrors.push(error),
      })
      manager.start()

      expect(managerErrors).toHaveLength(1)
      expect(String(managerErrors[0])).toContain(canonicalSurfaceId)
      expect(store.getTreeProposal(result.proposalId)?.status).toBe('pending')
      const stillImpostor = store.getSurface(canonicalSurfaceId)
      expect(stillImpostor?.title).toBe('Impostor') // never overwritten or archived
    })

    it('reopens an accepted proposal that provably never applied (a crash between resolve() claiming the row and calling patchTree), and its card stays clickable (issue 022 review fix)', async () => {
      const id = 'srf-target-crash-accepted'
      store.createSurface(targetSurface(id, 2), 'agent')
      store.setPinned(id, true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion(id)
      if (!version) throw new Error('expected Surface version')
      const result = store.patchTree(id, [addCaptionOperation('/children/2', 'proposed')], {
        expectedTreeVersion: version.treeVersion,
        updatedBy: 'agent',
      })
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')
      const cardSurfaceId = treeProposalSurfaceId(result.proposalId)

      // Simulate `resolve()` having claimed the row `accepted` right before a
      // crash, before `patchTree` ever ran: the target's tree/treeVersion are
      // still exactly what they were when the proposal was recorded.
      const claimed = store.resolveTreeProposal(result.proposalId, 'accepted')
      expect(claimed?.status).toBe('accepted')
      expect(store.getSurfaceVersion(id)?.treeVersion).toBe(version.treeVersion)

      manager.dispose()
      manager = new TreeProposalSurfaceManager({
        store,
        onError: (error) => managerErrors.push(error),
      })
      manager.start()

      expect(store.getTreeProposal(result.proposalId)?.status).toBe('pending')
      expect(store.getSurface(cardSurfaceId)).toBeDefined()
      expect(managerErrors).toHaveLength(0)

      // The reopened proposal is now genuinely acceptable again.
      pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
      await manager.flush()
      expect(store.getTreeProposal(result.proposalId)?.status).toBe('accepted')
      expect(store.getSurfaceVersion(id)?.treeVersion).toBe(version.treeVersion + 1)
    })

    it('leaves an accepted proposal alone when its patch already applied (treeVersion moved), never reopening or recreating its (already archived) card', async () => {
      const id = 'srf-target-already-applied'
      store.createSurface(targetSurface(id, 2), 'agent')
      store.setPinned(id, true, { origin: 'trusted:user', updatedBy: 'user' })
      const version = store.getSurfaceVersion(id)
      if (!version) throw new Error('expected Surface version')
      const result = store.patchTree(id, [addCaptionOperation('/children/2', 'proposed')], {
        expectedTreeVersion: version.treeVersion,
        updatedBy: 'agent',
      })
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')
      const cardSurfaceId = treeProposalSurfaceId(result.proposalId)

      pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
      await manager.flush()
      expect(store.getTreeProposal(result.proposalId)?.status).toBe('accepted')
      expect(store.getSurfaceVersion(id)?.treeVersion).toBe(version.treeVersion + 1)
      expect(store.getSurface(cardSurfaceId)).toBeUndefined() // archived

      manager.dispose()
      manager = new TreeProposalSurfaceManager({
        store,
        onError: (error) => managerErrors.push(error),
      })
      manager.start()

      expect(store.getTreeProposal(result.proposalId)?.status).toBe('accepted') // untouched
      expect(store.getSurface(cardSurfaceId)).toBeUndefined() // still archived, not recreated
      expect(managerErrors).toHaveLength(0)
    })
  })

  it('treeProposalIdFromSurfaceId inverts treeProposalSurfaceId, and rejects a surfaceId of the wrong shape', () => {
    expect(treeProposalIdFromSurfaceId(treeProposalSurfaceId(42))).toBe(42)
    expect(treeProposalIdFromSurfaceId('srf-approval-42')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-not-a-number')).toBeUndefined()
  })

  it('rejects every alias `Number()` used to accept onto a real proposal id (issue 022 review fix: a strict grammar, not Number.isInteger)', () => {
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-03')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-7.0')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal--7')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-+7')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-7e0')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-')).toBeUndefined()
    expect(treeProposalIdFromSurfaceId('srf-tree-proposal-0')).toBeUndefined()
  })

  it('neutralizes delimiter-collision attempts: a target title containing <<< does not appear verbatim in the card', () => {
    const { cardSurfaceId } = pinAndPropose('srf-target-tainted', 2, 'Tracker <<<evil>>> layout')

    const card = store.getSurface(cardSurfaceId)
    expect(card).toBeDefined()
    expect(card?.title).not.toContain('<<<evil>>>')
    const title = findNode(card!.tree, 'title')?.props?.['text']
    expect(title as string).not.toContain('<<<evil>>>')
  })

  describe('security: only the persisted daemon-owned card is clickable (issue 022 review fix)', () => {
    /** A Surface with a `decision-accept` Button, the same fast-action shape a real card declares — but not created by this manager. */
    function fakeDecisionCard(id: string): Surface {
      return SurfaceSchema.parse({
        id,
        spaceId: 'spc-health',
        title: 'Innocuous label',
        tree: {
          id: 'root',
          type: 'Box',
          children: [
            {
              id: 'decision-accept',
              type: 'Button',
              props: { label: 'OK' },
              actions: [
                {
                  name: 'press',
                  path: 'fast',
                  stateKey: DECISION_ACCEPT_KEY,
                  payload: { value: true },
                },
              ],
            },
          ],
        },
        state: { [DECISION_ACCEPT_KEY]: false },
        freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
      })
    }

    it('a click on srf-tree-proposal-03 (an id shape Number() used to alias onto a real proposal) is ignored: the pinned tree and the proposal stay untouched', () => {
      const { proposalId } = pinAndPropose('srf-target-alias-03', 2)
      const aliasId = 'srf-tree-proposal-03'
      store.createSurface(fakeDecisionCard(aliasId), 'agent')

      pressDecision(aliasId, DECISION_ACCEPT_KEY)

      expect(store.getTreeProposal(proposalId)?.status).toBe('pending')
      expect(
        store.getSurface('srf-target-alias-03')?.tree.children?.map((node) => node.id),
      ).toEqual(['node-0', 'node-1'])
      expect(managerErrors).toHaveLength(0)
    })

    it('a click on srf-tree-proposal-7.0 (an id shape Number() used to alias onto a real proposal) is ignored: the pinned tree and the proposal stay untouched', () => {
      const { proposalId } = pinAndPropose('srf-target-alias-70', 2)
      const aliasId = 'srf-tree-proposal-7.0'
      store.createSurface(fakeDecisionCard(aliasId), 'agent')

      pressDecision(aliasId, DECISION_ACCEPT_KEY)

      expect(store.getTreeProposal(proposalId)?.status).toBe('pending')
      expect(
        store.getSurface('srf-target-alias-70')?.tree.children?.map((node) => node.id),
      ).toEqual(['node-0', 'node-1'])
      expect(managerErrors).toHaveLength(0)
    })

    it('a click on a non-daemon-owned Surface sitting at the exact canonical proposal id is ignored: no preview, no bypassPin, no consent forged', async () => {
      manager.dispose() // detach: no daemon-owned card must exist yet for the impostor to occupy the canonical id

      store.createSurface(targetSurface('srf-target-impostor-click', 2), 'agent')
      store.setPinned('srf-target-impostor-click', true, {
        origin: 'trusted:user',
        updatedBy: 'user',
      })
      const version = store.getSurfaceVersion('srf-target-impostor-click')
      if (!version) throw new Error('expected Surface version')
      const result = store.patchTree(
        'srf-target-impostor-click',
        [addCaptionOperation('/children/2', 'proposed')],
        { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
      )
      if (!('proposed' in result)) throw new Error('expected a Tree proposal')
      const canonicalSurfaceId = treeProposalSurfaceId(result.proposalId)
      expect(store.getSurface(canonicalSurfaceId)).toBeUndefined() // no daemon-owned card exists yet

      // The Agent creates an innocuous-looking Surface at the exact
      // canonical id with a Button declaring the Accept fast action —
      // exactly the attack this fix closes.
      store.createSurface(fakeDecisionCard(canonicalSurfaceId), 'agent')
      expect(store.isSurfaceDaemonOwned(canonicalSurfaceId)).toBe(false)

      manager = new TreeProposalSurfaceManager({
        store,
        onError: (error) => managerErrors.push(error),
      })

      pressDecision(canonicalSurfaceId, DECISION_ACCEPT_KEY)
      await manager.flush()

      expect(store.getTreeProposal(result.proposalId)?.status).toBe('pending')
      expect(
        store.getSurface('srf-target-impostor-click')?.tree.children?.map((node) => node.id),
      ).toEqual(['node-0', 'node-1'])
      expect(managerErrors).toHaveLength(0)
    })
  })

  it('reopens a proposal that fails to apply at accept time (a state patch removed the key the proposed node binds while treeVersion stayed put), so a later legitimate accept works (issue 022 review fix)', async () => {
    store.createSurface(targetSurface('srf-target-reopen', 2), 'agent')
    // An extra state key the base tree does not bind, so removing it later
    // does not also break `node-0`'s own pre-existing `item0` binding —
    // only the proposed node below binds it.
    store.patchState(
      'srf-target-reopen',
      [{ target: 'state', op: 'add', path: '/reopenKey', value: false }],
      {
        updatedBy: 'agent',
      },
    )
    store.setPinned('srf-target-reopen', true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion('srf-target-reopen')
    if (!version) throw new Error('expected Surface version')

    const boundOperation: PatchOperation = {
      target: 'tree',
      op: 'add',
      path: '/children/2',
      value: {
        id: 'bound-note',
        type: 'Checkbox',
        binding: 'reopenKey',
        props: { label: 'note' },
        actions: [{ name: 'toggle', path: 'fast', stateKey: 'reopenKey', payload: {} }],
      },
    }
    const result = store.patchTree('srf-target-reopen', [boundOperation], {
      expectedTreeVersion: version.treeVersion,
      updatedBy: 'agent',
    })
    if (!('proposed' in result)) throw new Error('expected a Tree proposal')
    const cardSurfaceId = treeProposalSurfaceId(result.proposalId)

    // A state patch removes the key the proposed node binds — allowed even
    // though the target is pinned: only tree patches are gated by the pin.
    // `treeVersion` never moves, so Accept's staleness check still passes.
    store.patchState('srf-target-reopen', [{ target: 'state', op: 'remove', path: '/reopenKey' }], {
      updatedBy: 'agent',
    })

    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    await manager.flush()

    // Refused: the accept-time dry-run re-validation throws (the proposed
    // node still binds `reopenKey`, now gone from state) even though the
    // row was already claimed `accepted` — it must be put back to `pending`.
    expect(managerErrors).toHaveLength(1)
    expect(store.getTreeProposal(result.proposalId)?.status).toBe('pending')
    const card = store.getSurface(cardSurfaceId)
    expect(card).toBeDefined()
    const errorText = findNode(card!.tree, 'error')?.props?.['text']
    expect(errorText as string).toContain('applying this change failed')
    expect(card?.state[DECISION_ACCEPT_KEY]).toBe(false) // reset, not stuck at true

    // Restore the binding and accept again: the retry now succeeds.
    store.patchState(
      'srf-target-reopen',
      [{ target: 'state', op: 'add', path: '/reopenKey', value: false }],
      { updatedBy: 'agent' },
    )
    pressDecision(cardSurfaceId, DECISION_ACCEPT_KEY)
    await manager.flush()

    expect(store.getTreeProposal(result.proposalId)?.status).toBe('accepted')
    const target = store.getSurface('srf-target-reopen')
    expect(target?.tree.children?.map((node) => node.id)).toContain('bound-note')
    expect(managerErrors).toHaveLength(1) // no new error on the successful retry
  })

  it('a createCard failure (Surface already exists at the canonical id) is routed through onError, patchTree does not throw, and the proposal is still recorded exactly once (issue 022 review fix)', () => {
    store.createSurface(targetSurface('srf-target-cardfail', 2), 'agent')
    store.setPinned('srf-target-cardfail', true, { origin: 'trusted:user', updatedBy: 'user' })
    const version = store.getSurfaceVersion('srf-target-cardfail')
    if (!version) throw new Error('expected Surface version')

    // Pre-occupy the canonical card id for the proposal about to be
    // recorded (proposal ids are sequential in a fresh Store, so the first
    // proposal recorded in this test gets id 1): `createCard` will fail to
    // create its Surface there.
    const collidingCardId = treeProposalSurfaceId(1)
    store.createSurface(
      SurfaceSchema.parse({
        id: collidingCardId,
        spaceId: 'spc-health',
        title: 'Already occupied',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )

    // Does not throw: the card-creation failure is caught inside
    // `createCard` and routed through `onError`, never escaping `patchTree`.
    const result = store.patchTree(
      'srf-target-cardfail',
      [addCaptionOperation('/children/2', 'proposed')],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'agent' },
    )

    if (!('proposed' in result)) throw new Error('expected a Tree proposal')
    expect(result.proposalId).toBe(1)
    expect(store.getTreeProposal(1)?.status).toBe('pending')
    expect(store.listTreeProposals({ surfaceId: 'srf-target-cardfail' })).toHaveLength(1)
    expect(managerErrors).toHaveLength(1)
    expect(String(managerErrors[0])).toContain('already exists')
  })
})
