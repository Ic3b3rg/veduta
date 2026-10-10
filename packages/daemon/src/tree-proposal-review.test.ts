import { SurfaceSchema, literalSetPlan, type AtomNode, type PatchOperation } from '@veduta/protocol'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Store } from './store.ts'
import { TreePendingDecisionAdapter } from './tree-pending-decision.ts'
import { TreeProposalSurfaceManager, treeProposalSurfaceId } from './tree-proposal.ts'

let rootDir: string
let store: Store
let manager: TreeProposalSurfaceManager
const now = () => new Date('2026-10-10T12:00:00.000Z')

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-tree-review-'))
  store = new Store({ rootDir, now })
  manager = new TreeProposalSurfaceManager({ store })
})

afterEach(() => {
  manager.dispose()
  store.close()
  rmSync(rootDir, { recursive: true, force: true })
})

function createTarget(children: AtomNode[], state = {}) {
  store.createSurface(
    SurfaceSchema.parse({
      id: 'srf-delivery',
      spaceId: 'spc-health',
      title: 'Delivery plan',
      tree: { id: 'root', type: 'Box', children },
      state,
      freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
    }),
    'agent',
  )
  store.setPinned('srf-delivery', true, { origin: 'trusted:user', updatedBy: 'user' })
}

function propose(operations: PatchOperation[]) {
  const version = store.getSurfaceVersion('srf-delivery')!
  const result = store.patchTree('srf-delivery', operations, {
    expectedTreeVersion: version.treeVersion,
    updatedBy: 'agent',
  })
  if (!('proposed' in result)) throw new Error('expected Tree proposal')
  return {
    id: `tree-proposal:${result.proposalId}`,
    proposalId: result.proposalId,
    cardId: treeProposalSurfaceId(result.proposalId),
  }
}

function textNode(id: string, text: string): AtomNode {
  return { id, type: 'Text', props: { text } }
}

function readableText(node: AtomNode): string {
  const props = node.props
  return [
    props && 'text' in props ? props.text : '',
    props && 'label' in props ? props.label : '',
    ...(node.children ?? []).map(readableText),
  ].join('\n')
}

function reviewText(cardId: string): string {
  const card = store.getSurface(cardId)
  expect(card).toBeDefined()
  return readableText(card!.tree)
}

function disclosure(tree: AtomNode, label: RegExp): AtomNode | undefined {
  if (tree.type === 'Collapsible' && label.test(tree.props.label)) return tree
  for (const child of tree.children ?? []) {
    const found = disclosure(child, label)
    if (found) return found
  }
  return undefined
}

describe('complete Tree proposal review', () => {
  it('shows removed content and the full before/after text, including changes beyond the old preview limits', () => {
    const prefix = 'Read this complete delivery agreement. '.repeat(150)
    const previous = `${prefix}Deliver by 10 October`
    const proposed = `${prefix}Deliver by 12 October`
    createTarget([textNode('agreement', previous), textNode('obsolete', 'Remove the rush charge')])
    const review = propose([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: textNode('agreement', proposed),
      },
      { target: 'tree', op: 'remove', path: '/children/1' },
    ])

    const content = reviewText(review.cardId)
    expect(content).toContain(previous)
    expect(content).toContain(proposed)
    expect(content).toContain('Remove the rush charge')
    expect(content).toContain('Before')
    expect(content).toContain('After')
    expect(content).toContain('Accept applies')
    expect(content).toContain('Reject keeps')
    const summary = new TreePendingDecisionAdapter(store, manager).get(review.id)?.summary
    expect(summary).toContain('10 October')
    expect(summary).toContain('12 October')
    expect(store.getSurface('srf-delivery')?.tree.children?.[0]).toEqual(
      textNode('agreement', previous),
    )
  })

  it('reviews operations in order, naming the real removal after an insertion and the concrete move', () => {
    createTarget([
      textNode('deadline', 'Deliver by 10 October'),
      textNode('follow-up', 'Call after delivery'),
    ])
    const review = propose([
      {
        target: 'tree',
        op: 'add',
        path: '/children/0',
        value: textNode('new', 'Confirm the address'),
      },
      { target: 'tree', op: 'remove', path: '/children/1' },
      { target: 'tree', op: 'move', from: '/children/1', path: '/children/0' },
    ])
    const card = store.getSurface(review.cardId)!
    const removal = disclosure(card.tree, /^2\. Remove/)
    const move = disclosure(card.tree, /^3\. Move/)
    expect(removal).toBeDefined()
    expect(readableText(removal!)).toContain('Deliver by 10 October')
    expect(readableText(removal!)).not.toContain('Confirm the address')
    expect(move).toBeDefined()
    expect(readableText(move!)).toContain('Call after delivery')
    expect(readableText(move!)).toContain('/children/1')
    expect(readableText(move!)).toContain('/children/0')

    const adapter = new TreePendingDecisionAdapter(store, manager)
    expect(adapter.get(review.id)?.summary).toContain('Delivery plan')
    expect(adapter.get(review.id)?.summary).toContain('Confirm the address')
    expect(adapter.get(review.id)?.summary).toContain('Remove')
  })

  it('shows complete collection, binding and action differences as inert text', () => {
    createTarget(
      [
        { id: 'value', type: 'Text', binding: 'oldValue' },
        {
          id: 'send',
          type: 'Button',
          props: { label: 'Send' },
          actions: [{ name: 'press', path: 'fast', plan: literalSetPlan('sent', false) }],
        },
      ],
      { oldValue: 'Old destination', newValue: 'New destination', sent: false },
    )
    const rows = Array.from({ length: 100 }, (_, index) => ({
      destination: `Destination ${index}`,
    }))
    const review = propose([
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: { id: 'value', type: 'Text', binding: 'newValue' },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: {
          id: 'send',
          type: 'Button',
          props: { label: 'Send' },
          actions: [{ name: 'press', path: 'fast', plan: literalSetPlan('sent', true) }],
        },
      },
      {
        target: 'tree',
        op: 'add',
        path: '/children/2',
        value: { id: 'destinations', type: 'Table', props: { columns: ['destination'], rows } },
      },
      {
        target: 'tree',
        op: 'add',
        path: '/children/3',
        value: {
          id: 'remote',
          type: 'Image',
          props: { src: 'https://example.com/never-request.jpg', alt: 'Remote image' },
        },
      },
    ])
    const content = reviewText(review.cardId)
    for (const expected of [
      'oldValue',
      'newValue',
      'Old destination',
      'New destination',
      'false',
      'true',
      'Destination 99',
      'https://example.com/never-request.jpg',
    ]) {
      expect(content).toContain(expected)
    }
    const card = store.getSurface(review.cardId)!
    const interactive: string[] = []
    function inspect(node: AtomNode): void {
      if (node.actions || node.binding || node.type === 'Image') interactive.push(node.id)
      node.children?.forEach(inspect)
    }
    inspect(card.tree)
    expect(interactive.sort()).toEqual(['decision-accept', 'decision-reject'])
  })

  it('keeps the exact pending review after daemon recovery and applies the reviewed batch only once', async () => {
    createTarget([textNode('deadline', 'Deliver by 10 October'), textNode('note', 'Phone first')])
    const operations: PatchOperation[] = [
      { target: 'tree', op: 'remove', path: '/children/0' },
      {
        target: 'tree',
        op: 'add',
        path: '/children/1',
        value: textNode('new', 'Deliver by 12 October'),
      },
    ]
    const review = propose(operations)
    const content = reviewText(review.cardId)
    manager.dispose()
    store.close()
    store = new Store({ rootDir, now })
    manager = new TreeProposalSurfaceManager({ store })
    manager.start()
    expect(reviewText(review.cardId)).toBe(content)
    const adapter = new TreePendingDecisionAdapter(store, manager)
    await adapter.resolve(review.id, 'accept', 'trusted:user')
    await adapter.resolve(review.id, 'accept', 'trusted:user')
    expect(store.getSurface('srf-delivery')?.tree.children).toEqual([
      textNode('note', 'Phone first'),
      textNode('new', 'Deliver by 12 October'),
    ])
    expect(
      store
        .eventLog('spc-health')
        .filter((event) => event.type === 'surface.tree_proposal_accepted'),
    ).toHaveLength(1)
  })

  it('does not reconstruct a current comparison from the wrong version after a missing-card recovery', () => {
    createTarget([textNode('deadline', 'Deliver by 10 October'), textNode('note', 'Phone first')])
    manager.dispose()
    const review = propose([{ target: 'tree', op: 'remove', path: '/children/0' }])
    const version = store.getSurfaceVersion('srf-delivery')!
    store.patchTree(
      'srf-delivery',
      [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/0',
          value: textNode('deadline', 'A newer, unrelated deadline'),
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'user', bypassPin: true },
    )
    manager = new TreeProposalSurfaceManager({ store })
    manager.start()
    const content = reviewText(review.cardId)
    expect(content).toContain('no longer matches')
    expect(content).not.toContain('A newer, unrelated deadline')
    expect(store.getTreeProposal(review.proposalId)?.status).toBe('pending')
  })

  it('keeps the prepared comparison visibly unavailable when the live target changes, then rejects without another target write', async () => {
    createTarget([textNode('deadline', 'Deliver by 10 October'), textNode('note', 'Phone first')])
    const review = propose([{ target: 'tree', op: 'remove', path: '/children/0' }])
    const version = store.getSurfaceVersion('srf-delivery')!
    store.patchTree(
      'srf-delivery',
      [
        {
          target: 'tree',
          op: 'replace',
          path: '/children/0',
          value: textNode('deadline', 'Deliver by 15 October'),
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'user', bypassPin: true },
    )
    const content = reviewText(review.cardId)
    expect(content).toContain('no longer matches')
    expect(content).toContain('Deliver by 10 October')
    expect(content).not.toContain('Deliver by 15 October')
    expect(content).toContain('Accept is unavailable')
    expect(content).not.toContain('Accept applies')
    expect(content.split('\n')).not.toContain('Accept')
    expect(content.split('\n')).toContain('Reject')
    manager.dispose()
    manager = new TreeProposalSurfaceManager({ store })
    manager.start()
    expect(reviewText(review.cardId)).toBe(content)
    const current = store.getSurface('srf-delivery')
    await new TreePendingDecisionAdapter(store, manager).resolve(
      review.id,
      'reject',
      'trusted:user',
    )
    expect(store.getSurface('srf-delivery')).toEqual(current)
  })

  it('shows an unavailable target truthfully after recovery and preserves rejection', async () => {
    createTarget([textNode('deadline', 'Deliver by 10 October'), textNode('note', 'Phone first')])
    manager.dispose()
    const review = propose([{ target: 'tree', op: 'remove', path: '/children/0' }])
    store.archiveSurface('srf-delivery', 'user')
    manager = new TreeProposalSurfaceManager({ store })
    manager.start()
    expect(reviewText(review.cardId)).toContain('target Surface is no longer available')
    const decision = await new TreePendingDecisionAdapter(store, manager).resolve(
      review.id,
      'reject',
      'trusted:user',
    )
    expect(decision).toMatchObject({ outcome: 'rejected', state: 'terminal' })
    expect(store.getSurface('srf-delivery')).toBeUndefined()
  })

  it('restores complete inspection when missing live data recovers without changing the reviewed tree version', () => {
    createTarget([textNode('note', 'Phone first')], { destination: 'Rome' })
    manager.dispose()
    const review = propose([
      {
        target: 'tree',
        op: 'add',
        path: '/children/1',
        value: { id: 'address', type: 'Text', binding: 'destination' },
      },
    ])
    store.patchState('srf-delivery', [{ target: 'state', op: 'remove', path: '/destination' }], {
      updatedBy: 'user',
    })
    manager = new TreeProposalSurfaceManager({ store })
    manager.start()
    expect(reviewText(review.cardId)).toContain('no longer validates')
    store.patchState(
      'srf-delivery',
      [{ target: 'state', op: 'add', path: '/destination', value: 'Milan' }],
      { updatedBy: 'user' },
    )
    expect(reviewText(review.cardId)).toContain('Milan')
    expect(reviewText(review.cardId)).toContain('Accept applies')
    expect(reviewText(review.cardId)).not.toContain('Review unavailable')
  })

  it('restores acceptance after live data recovers while preserving the prepared comparison', () => {
    createTarget([textNode('note', 'Phone first')], { destination: 'Rome' })
    const review = propose([
      {
        target: 'tree',
        op: 'add',
        path: '/children/1',
        value: { id: 'address', type: 'Text', binding: 'destination' },
      },
    ])
    const prepared = reviewText(review.cardId)
    const adapter = new TreePendingDecisionAdapter(store, manager)
    expect(adapter.get(review.id)?.allowedResolutions).toEqual(['accept', 'reject'])
    store.patchState('srf-delivery', [{ target: 'state', op: 'remove', path: '/destination' }], {
      updatedBy: 'user',
    })
    const unavailable = reviewText(review.cardId)
    expect(unavailable).toContain('Accept is unavailable')
    expect(unavailable.split('\n')).not.toContain('Accept')
    expect(unavailable).toContain('Rome')
    expect(adapter.get(review.id)?.allowedResolutions).toEqual(['reject'])
    store.patchState(
      'srf-delivery',
      [{ target: 'state', op: 'add', path: '/destination', value: 'Milan' }],
      { updatedBy: 'user' },
    )
    expect(reviewText(review.cardId)).toBe(prepared)
    expect(adapter.get(review.id)?.allowedResolutions).toEqual(['accept', 'reject'])
    const cursor = store.latestSurfaceCursor()
    manager.dispose()
    manager = new TreeProposalSurfaceManager({ store })
    manager.start()
    expect(reviewText(review.cardId)).toBe(prepared)
    expect(store.latestSurfaceCursor()).toBe(cursor)
  })
})
