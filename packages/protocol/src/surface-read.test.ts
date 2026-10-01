import { describe, expect, it } from 'vitest'
import {
  AtomNodeSchema,
  SurfaceSchema,
  SurfaceTemplateSchema,
  RenderableAtomNodeSchema,
  RenderableSurfaceSchema,
  RenderablePatchSchema,
  PatchSchema,
  applyRenderableSurfacePatch,
  formSetPlan,
  collectRenderableNodeBindingRefs,
  RenderableFastActionOutcomeSchema,
  FastActionOutcomeSchema,
  type JsonObject,
} from './index.ts'

function surface(tree: unknown, state: JsonObject = { detail: 'Canonical content' }) {
  return {
    id: 'srf-future',
    spaceId: 'spc-test',
    title: 'Future composition',
    tree,
    state,
    freshness: { updatedAt: '2026-10-01T08:00:00Z', updatedBy: 'agent' },
  }
}

function futureTree(children: unknown[] = [{ id: 'known', type: 'Text', binding: 'detail' }]) {
  return {
    id: 'future',
    type: 'FutureGauge',
    props: { reading: 74 },
    binding: { futureSource: 'data' },
    actions: { futureVerb: 'record' },
    futureRevision: 2,
    children,
  }
}

describe('read-only Surface version compatibility', () => {
  it('correlates a committed known Action through future layout metadata without treating that metadata as executable', () => {
    const form = {
      id: 'form',
      type: 'Form',
      props: { label: 'Record', submitLabel: 'Save' },
      actions: [
        { name: 'submit', path: 'fast', revision: 'acr-example', plan: formSetPlan(['note']) },
      ],
      children: [
        futureTree([{ id: 'note', type: 'Input', binding: 'note', props: { label: 'Note' } }]),
      ],
    }
    const outcome = {
      outcome: 'committed',
      surfaceId: 'srf-future',
      nodeId: 'form',
      actionName: 'submit',
      actionRevision: 'acr-example',
      intentId: '106c313d-9948-44fa-a3fe-01919ba47d75',
      surface: surface(form, { note: 'Recorded' }),
      patch: {
        surfaceId: 'srf-future',
        operations: [{ target: 'state', op: 'replace', path: '/note', value: 'Recorded' }],
      },
      surfaceVersion: 2,
      treeVersion: 1,
      surfaceCommitId: 'scm-example',
      eventCursor: 1,
      surfaceCursor: 1,
      duplicate: false,
    }
    expect(RenderableFastActionOutcomeSchema.safeParse(outcome).success).toBe(true)
    expect(FastActionOutcomeSchema.safeParse(outcome).success).toBe(false)
    expect(
      RenderableFastActionOutcomeSchema.safeParse({ ...outcome, actionRevision: 'acr-other' })
        .success,
    ).toBe(false)
    expect(
      RenderableFastActionOutcomeSchema.safeParse({ ...outcome, nodeId: 'future' }).success,
    ).toBe(false)
  })
  it('retains future JSON metadata while validating and tracking known descendants', () => {
    const parsed = RenderableSurfaceSchema.parse(JSON.parse(JSON.stringify(surface(futureTree()))))
    expect(parsed.tree).toEqual(futureTree())
    expect(collectRenderableNodeBindingRefs(parsed.tree, ['tree']).map((ref) => ref.key)).toEqual([
      'detail',
    ])
  })

  it.each([
    { id: 'bad-title', type: 'Title', props: { value: 'Undeclared field' } },
    { id: 'bad-image', type: 'Image', props: { src: '/photo.png' } },
    { id: 'bad-text', type: 'Text', binding: 'detail', futureRevision: 2 },
    { id: 'bad-children', type: 'Text', props: { text: 'Leaf' }, children: [futureTree([])] },
    {
      id: 'bad-actions',
      type: 'Stat',
      props: { label: 'Recorded', value: 74 },
      actions: [{ name: 'record', path: 'agent' }],
    },
  ])('rejects an invalid known branch inside an unknown parent: $id', (known) => {
    expect(RenderableSurfaceSchema.safeParse(surface(futureTree([known]))).success).toBe(false)
  })

  it('does not reinterpret a known type or malformed envelope as a future contract', () => {
    for (const type of ['', '  ', 'Text ', 'Box ']) {
      expect(RenderableAtomNodeSchema.safeParse({ id: 'future', type }).success).toBe(false)
    }
    expect(
      RenderableSurfaceSchema.safeParse(surface({ ...futureTree(), children: {} })).success,
    ).toBe(false)
    expect(RenderableSurfaceSchema.safeParse(surface({ ...futureTree(), props: [] })).success).toBe(
      false,
    )
    expect(RenderableSurfaceSchema.safeParse(surface(futureTree(), { detail: 74 })).success).toBe(
      false,
    )
    expect(RenderableSurfaceSchema.safeParse(surface(futureTree(), {})).success).toBe(false)
  })

  it('retains the actual Form ancestor context across an unknown wrapper', () => {
    const input = { id: 'note', type: 'Input', binding: 'note', props: { label: 'Note' } }
    const wrapper = futureTree([input])
    expect(RenderableSurfaceSchema.safeParse(surface(wrapper, { note: '' })).success).toBe(false)
    const form = {
      id: 'form',
      type: 'Form',
      props: { label: 'Record', submitLabel: 'Save' },
      actions: [{ name: 'submit', path: 'fast', plan: formSetPlan(['note']) }],
      children: [wrapper],
    }
    expect(RenderableSurfaceSchema.safeParse(surface(form, { note: '' })).success).toBe(true)
    expect(RenderableSurfaceSchema.safeParse(surface(form, { note: 1 })).success).toBe(false)
  })

  it('keeps authoring, canonical persistence, and Template import closed to future types', () => {
    const received = RenderableSurfaceSchema.parse(surface(futureTree()))
    expect(AtomNodeSchema.safeParse(received.tree).success).toBe(false)
    expect(SurfaceSchema.safeParse(received).success).toBe(false)
    expect(
      SurfaceTemplateSchema.safeParse({
        formatVersion: 1,
        id: 'tpl-future',
        name: 'Future composition',
        intent: 'Read compatibility must not authorize authoring',
        tree: received.tree,
        stateKeys: ['detail'],
        dataProps: [],
        provenance: {
          sourceSurfaceId: received.id,
          sourceSpaceId: received.spaceId,
          savedAt: received.freshness.updatedAt,
          savedBy: 'pin',
          origin: 'trusted:user',
        },
      }).success,
    ).toBe(false)
  })

  it('replays an unknown tree replacement atomically without accepting it as an authoring patch', () => {
    const previous = RenderableSurfaceSchema.parse(
      surface({
        id: 'root',
        type: 'Box',
        children: [{ id: 'known', type: 'Text', binding: 'detail' }],
      }),
    )
    const wirePatch = {
      surfaceId: previous.id,
      operations: [{ target: 'tree', op: 'replace', path: '/children/0', value: futureTree() }],
    }
    expect(PatchSchema.safeParse(wirePatch).success).toBe(false)
    const next = applyRenderableSurfacePatch(previous, RenderablePatchSchema.parse(wirePatch))
    expect(next.tree.children?.[0]).toEqual(futureTree())
    const invalid = RenderablePatchSchema.parse({
      surfaceId: previous.id,
      operations: [
        { target: 'tree', op: 'replace', path: '/children/0', value: futureTree() },
        { target: 'state', op: 'replace', path: '/detail', value: 74 },
      ],
    })
    expect(() => applyRenderableSurfacePatch(previous, invalid)).toThrow()
    expect(previous.tree.children?.[0]?.type).toBe('Text')
    expect(previous.state['detail']).toBe('Canonical content')
  })
})
