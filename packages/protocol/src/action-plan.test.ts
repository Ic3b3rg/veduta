import { describe, expect, it } from 'vitest'
import { SurfaceSchema } from './surface.ts'
import { FastActionInvocationSchema } from './patch.ts'
import { FastActionOutcomeSchema } from './action-outcome.ts'

function collectionSurface() {
  return {
    id: 'collection',
    spaceId: 'space',
    title: 'Items',
    freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'agent' },
    state: { draft: '', items: [] },
    tree: {
      id: 'form',
      type: 'Form',
      props: { label: 'Add item', submitLabel: 'Add' },
      children: [{ id: 'draft', type: 'Input', binding: 'draft', props: { label: 'Item' } }],
      actions: [
        {
          name: 'submit',
          path: 'fast',
          plan: {
            inputs: { draft: { type: 'string' } },
            targets: {
              draft: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  identityKey: 'id',
                  fields: { id: { type: 'string' }, label: { type: 'string' } },
                },
              },
            },
            steps: [
              {
                op: 'append',
                target: 'items',
                value: {
                  source: 'object',
                  fields: {
                    id: { source: 'metadata', name: 'recordId' },
                    label: { source: 'input', name: 'draft' },
                  },
                },
              },
              { op: 'clear', target: 'draft', value: '' },
            ],
          },
        },
      ],
    },
  }
}

describe('closed fast Action plans', () => {
  it('accepts a command Form that appends one record and clears its local draft source', () => {
    const surface = SurfaceSchema.parse(collectionSurface())
    expect(SurfaceSchema.parse(JSON.parse(JSON.stringify(surface)))).toEqual(surface)
    expect(surface.tree.actions?.[0]).toMatchObject({
      path: 'fast',
      plan: { steps: [{ op: 'append' }, { op: 'clear' }] },
    })
  })
  it('rejects a missing target, undeclared input, and collection identity ambiguity before persistence', () => {
    const absent = collectionSurface()
    expect(SurfaceSchema.safeParse({ ...absent, state: { draft: '' } }).success).toBe(false)
    const undeclared = collectionSurface()
    const action = undeclared.tree.actions[0]!
    const tree = {
      ...undeclared.tree,
      actions: [
        {
          ...action,
          plan: {
            ...action.plan,
            steps: [
              { op: 'append', target: 'items', value: { source: 'input', name: 'other' } },
              ...action.plan.steps.slice(1),
            ],
          },
        },
      ],
    }
    expect(SurfaceSchema.safeParse({ ...undeclared, tree }).success).toBe(false)
    const ambiguous = collectionSurface()
    const state = {
      draft: '',
      items: [
        { id: 'same', label: 'A' },
        { id: 'same', label: 'B' },
      ],
    }
    expect(SurfaceSchema.safeParse({ ...ambiguous, state }).success).toBe(false)
  })
  it('closes the invocation and validates committed outcome identity and cursors', () => {
    const identity = {
      surfaceId: 'collection',
      nodeId: 'form',
      actionName: 'submit',
      actionRevision: 'acr-example',
      intentId: '106c313d-9948-44fa-a3fe-01919ba47d75',
    }
    const invocation = {
      nodeId: identity.nodeId,
      name: identity.actionName,
      actionRevision: identity.actionRevision,
      intentId: identity.intentId,
      inputs: { draft: 'Bread' },
    }
    expect(FastActionInvocationSchema.parse(invocation)).toEqual(invocation)
    expect(FastActionInvocationSchema.safeParse({ ...invocation, target: 'items' }).success).toBe(
      false,
    )
    const outcome = {
      ...identity,
      outcome: 'committed',
      surface: collectionSurface(),
      patch: {
        surfaceId: 'collection',
        operations: [{ target: 'state', op: 'replace', path: '/draft', value: '' }],
      },
      surfaceVersion: 2,
      treeVersion: 1,
      surfaceCommitId: 'scm-example',
      eventCursor: 1,
      surfaceCursor: 1,
      duplicate: false,
    }
    expect(FastActionOutcomeSchema.safeParse(outcome).success).toBe(true)
    expect(FastActionOutcomeSchema.safeParse({ ...outcome, surfaceId: 'other' }).success).toBe(
      false,
    )
    expect(FastActionOutcomeSchema.safeParse({ ...outcome, surfaceCursor: 2 }).success).toBe(false)
  })
})
