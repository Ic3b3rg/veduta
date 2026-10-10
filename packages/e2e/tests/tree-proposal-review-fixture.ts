import { randomUUID } from 'node:crypto'
import { SurfaceSchema, literalSetPlan, type PatchOperation } from '../../protocol/src/index.ts'
import { ChatTimeline } from '../../daemon/src/chat-timeline.ts'
import { Store } from '../../daemon/src/store.ts'
import { TreePendingDecisionAdapter } from '../../daemon/src/tree-pending-decision.ts'
import {
  TreeProposalSurfaceManager,
  treeProposalSurfaceId,
} from '../../daemon/src/tree-proposal.ts'

/** Creates disposable, canonical review data for the issue #227 authenticated browser journey. */
export function createTreeProposalReview(rootDir: string, surfaceId = 'srf-delivery-review') {
  const store = new Store({ rootDir })
  const manager = new TreeProposalSurfaceManager({ store })
  const timeline = new ChatTimeline(rootDir)
  const oldText = `${'Read every delivery condition before confirming. '.repeat(120)}\nDeliver by 10 October.`
  const newText = `${'Read every delivery condition before confirming. '.repeat(120)}\nDeliver by 12 October.`
  try {
    store.createSurface(
      SurfaceSchema.parse({
        id: surfaceId,
        spaceId: 'spc-health',
        title: 'Delivery review',
        tree: {
          id: 'delivery-root',
          type: 'Box',
          children: [
            { id: 'agreement', type: 'Text', props: { text: oldText } },
            { id: 'fee', type: 'Text', props: { text: 'Express fee: €25' } },
            {
              id: 'confirmation',
              type: 'Button',
              props: { label: 'Confirm delivery' },
              actions: [{ name: 'press', path: 'fast', plan: literalSetPlan('confirmed', false) }],
            },
            { id: 'destination', type: 'Text', binding: 'oldDestination' },
            { id: 'follow-up', type: 'Text', props: { text: 'Call after delivery' } },
          ],
        },
        state: { oldDestination: 'Rome', newDestination: 'Milan', confirmed: false },
        freshness: { updatedAt: new Date().toISOString(), updatedBy: 'user' },
      }),
      'user',
    )
    store.setPinned(surfaceId, true, { origin: 'trusted:user', updatedBy: 'user' })
    const operations: PatchOperation[] = [
      { target: 'tree', op: 'remove', path: '/children/1' },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/0',
        value: { id: 'agreement', type: 'Text', props: { text: newText } },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/1',
        value: {
          id: 'confirmation',
          type: 'Button',
          props: { label: 'Confirm delivery' },
          actions: [{ name: 'press', path: 'fast', plan: literalSetPlan('confirmed', true) }],
        },
      },
      {
        target: 'tree',
        op: 'replace',
        path: '/children/2',
        value: { id: 'destination', type: 'Text', binding: 'newDestination' },
      },
      { target: 'tree', op: 'move', from: '/children/3', path: '/children/0' },
      {
        target: 'tree',
        op: 'add',
        path: '/children/4',
        value: {
          id: 'stops',
          type: 'Table',
          props: {
            columns: ['stop'],
            rows: Array.from({ length: 100 }, (_, index) => ({
              stop: `Delivery stop ${index + 1}`,
            })),
          },
        },
      },
      {
        target: 'tree',
        op: 'add',
        path: '/children/5',
        value: {
          id: 'image',
          type: 'Image',
          props: {
            src: '/review-image-must-not-load-before-acceptance.png',
            alt: 'Delivery image',
          },
        },
      },
    ]
    const version = store.getSurfaceVersion(surfaceId)!
    const recorded = store.patchTree(surfaceId, operations, {
      expectedTreeVersion: version.treeVersion,
      updatedBy: 'agent',
    })
    if (!('proposed' in recorded)) throw new Error('Expected a Tree proposal')
    const decisionId = `tree-proposal:${recorded.proposalId}`
    const decision = new TreePendingDecisionAdapter(store, manager).get(decisionId)
    if (!decision) throw new Error('Expected a Pending decision')
    const turn = timeline.accept({
      submissionId: randomUUID(),
      scope: decision.scope,
      text: 'Review these delivery changes.',
    })
    timeline.begin(turn.turnId)
    timeline.addDecision(turn.turnId, decision)
    timeline.completeWithDecisions(turn.turnId)
    return {
      targetId: surfaceId,
      decisionId,
      cardId: treeProposalSurfaceId(recorded.proposalId),
      proposalId: recorded.proposalId,
      expectedTreeVersion: version.treeVersion,
      operations,
      title: 'Proposed change: Delivery review',
      summary: decision.summary,
      oldText,
      newText,
    }
  } finally {
    timeline.close()
    manager.dispose()
    store.close()
  }
}
