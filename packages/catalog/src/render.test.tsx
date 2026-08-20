// @vitest-environment jsdom
import { AtomNodeSchema, atomTypes, type AtomNode } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalogTokens } from './design-system.ts'
import { renderNode } from './render.tsx'
import { catalogShowcaseSurface } from './showcase.ts'

const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  if (originalAnimate) {
    Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  } else {
    Reflect.deleteProperty(Element.prototype, 'animate')
  }
})

const tree: AtomNode = AtomNodeSchema.parse({
  id: 'root',
  type: 'Box',
  children: [
    { id: 'title', type: 'Title', props: { text: 'Groceries' } },
    {
      id: 'milk',
      type: 'Checkbox',
      binding: 'milk',
      props: { label: 'Milk' },
      actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
    },
    { id: 'weird', type: 'Transition' },
  ],
})

describe('renderNode', () => {
  it('renders a validated tree with state bindings', () => {
    render(renderNode(tree, { state: { milk: true }, dispatch: vi.fn() }))
    expect(screen.getByText('Groceries')).toBeDefined()
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  })

  it('dispatches the declared action on interaction, with the new value', () => {
    const dispatch = vi.fn()
    render(renderNode(tree, { state: { milk: false }, dispatch }))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(dispatch).toHaveBeenCalledTimes(1)
    const [node, actionName, value] = dispatch.mock.calls[0]!
    expect(node.id).toBe('milk')
    expect(actionName).toBe('toggle')
    expect(value).toBe(true)
  })

  it('renders unimplemented atom types visibly instead of crashing', () => {
    const motionBrowser = installMotionBrowser(false)
    const futureTree: AtomNode = JSON.parse('{"id":"future","type":"FutureAtom"}')
    const view = render(renderNode(futureTree, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureAtom')
    motionBrowser.calls.length = 0

    const newerTree: AtomNode = JSON.parse('{"id":"future","type":"NewerAtom"}')
    view.rerender(
      renderNode(newerTree, {
        state: {},
        dispatch: vi.fn(),
        motion: { update: { key: 'future-patch', atomIds: ['future'] } },
      }),
    )

    expect(screen.getByTestId('unknown-atom').textContent).toContain('NewerAtom')
    expect(contentKeysFor(motionBrowser, 'future')).toEqual(['content'])
  })

  it('staggers newly mounted sibling Atoms and does not re-animate persistent ids', () => {
    const motionBrowser = installMotionBrowser(false)
    const view = render(renderNode(tree, { state: { milk: true }, dispatch: vi.fn() }))
    const initialCalls = motionCalls(motionBrowser)

    expect(initialCalls.map(({ nodeId }) => nodeId)).toEqual(['title', 'milk', 'weird', 'root'])
    expect(initialCalls.map(({ delay }) => delay)).toEqual([0, 45, 90, 0])
    expect(initialCalls.every(({ duration }) => duration === 240)).toBe(true)
    expect(
      initialCalls.every(({ easing }) => easing === catalogTokens.light.motion.entranceEasing),
    ).toBe(true)

    view.rerender(renderNode(tree, { state: { milk: false }, dispatch: vi.fn() }))
    expect(motionBrowser.animate).toHaveBeenCalledTimes(4)

    const withNewSibling = AtomNodeSchema.parse({
      ...tree,
      children: [
        ...(tree.children ?? []),
        { id: 'new-caption', type: 'Caption', props: { text: 'Just added' } },
      ],
    })
    view.rerender(renderNode(withNewSibling, { state: { milk: false }, dispatch: vi.fn() }))

    expect(motionCalls(motionBrowser).at(-1)).toMatchObject({ nodeId: 'new-caption', delay: 135 })
  })

  it('renders instantly without entrance animation when reduced motion is preferred', () => {
    const { animate } = installMotionBrowser(true)
    const view = render(renderNode(tree, { state: { milk: true }, dispatch: vi.fn() }))
    view.rerender(
      renderNode(tree, {
        state: { milk: false },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-1', atomIds: ['milk'] } },
      }),
    )
    expect(animate).not.toHaveBeenCalled()
  })

  it('marks only the updated Atom region, once per patch key, without hiding it', () => {
    const motionBrowser = installMotionBrowser(false)
    const view = render(renderNode(tree, { state: { milk: true }, dispatch: vi.fn() }))

    view.rerender(
      renderNode(tree, {
        state: { milk: false },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-1', atomIds: ['milk'] } },
      }),
    )

    expect(motionCalls(motionBrowser)).toHaveLength(6)
    const firstPatchCalls = motionBrowser.calls.slice(-2)
    expect(firstPatchCalls.map(({ contentKey }) => contentKey)).toEqual([null, 'value'])
    expect(firstPatchCalls[0]).toMatchObject({
      nodeId: 'milk',
      options: { duration: 720 },
    })
    expect(firstPatchCalls[0]?.keyframes).toEqual([
      { outline: '0 solid #246b58', outlineOffset: '0', offset: 0 },
      {
        outline: '4px solid #246b58',
        outlineOffset: '4px',
        offset:
          catalogTokens.light.motion.entranceDurationMs /
          catalogTokens.light.motion.updateFeedbackDurationMs,
      },
      { outline: '0 solid #246b58', outlineOffset: '8px', offset: 1 },
    ])

    view.rerender(
      renderNode(tree, {
        state: { milk: true },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-1', atomIds: ['milk'] } },
      }),
    )
    expect(motionBrowser.animate).toHaveBeenCalledTimes(6)

    view.rerender(
      renderNode(tree, {
        state: { milk: false },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-2', atomIds: ['milk'] } },
      }),
    )
    expect(motionCalls(motionBrowser).at(-1)?.nodeId).toBe('milk')
    expect(motionBrowser.animate).toHaveBeenCalledTimes(8)
  })

  it('fades only a newly inserted Table row while existing rows stay visible', () => {
    const motionBrowser = installMotionBrowser(false)
    const mealsTree = AtomNodeSchema.parse({
      id: 'meals-root',
      type: 'Box',
      children: [
        {
          id: 'meal-table',
          type: 'Table',
          binding: 'meals',
          props: { columns: ['time', 'meal'] },
        },
      ],
    })
    const view = render(
      renderNode(mealsTree, {
        state: {
          meals: [
            { time: '12:00', meal: 'pasta' },
            { time: '08:00', meal: 'yogurt' },
          ],
        },
        dispatch: vi.fn(),
      }),
    )
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(mealsTree, {
        state: {
          meals: [
            { time: '13:00', meal: 'fesa di tacchino' },
            { time: '12:00', meal: 'pasta' },
            { time: '08:00', meal: 'yogurt' },
          ],
        },
        dispatch: vi.fn(),
        motion: { update: { key: 'meal-patch', atomIds: ['meal-table'] } },
      }),
    )

    const tableCalls = motionBrowser.calls.filter(({ nodeId }) => nodeId === 'meal-table')
    const rowCalls = tableCalls.filter(({ targetTag }) => targetTag === 'TR')
    expect(rowCalls.map(({ targetText }) => targetText)).toEqual(['13:00fesa di tacchino'])
    expect(rowCalls[0]?.options).toMatchObject({
      delay: 0,
      duration: catalogTokens.light.motion.entranceDurationMs,
      easing: catalogTokens.light.motion.entranceEasing,
      fill: 'backwards',
    })
    expect(rowCalls[0]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
    expect(tableCalls.filter(({ targetTag }) => targetTag === 'DIV')).toHaveLength(1)
    expect(
      tableCalls.find(({ targetText }) => targetText.includes('pasta'))?.keyframes,
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ opacity: 0 })]))
  })

  it('fades newly added Table headers without reanimating existing headers', () => {
    const motionBrowser = installMotionBrowser(false)
    const before = AtomNodeSchema.parse({
      id: 'table',
      type: 'Table',
      binding: 'rows',
      props: { columns: ['meal'] },
    })
    const after = AtomNodeSchema.parse({ ...before, props: { columns: ['time', 'meal'] } })
    const state = { rows: [{ time: '13:00', meal: 'fesa di tacchino' }] }
    const view = render(renderNode(before, { state, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(after, {
        state,
        dispatch: vi.fn(),
        motion: { update: { key: 'column-patch', atomIds: ['table'] } },
      }),
    )

    const headerCalls = contentFadeCallsFor(motionBrowser, 'table').filter(
      ({ targetTag }) => targetTag === 'TH',
    )
    expect(headerCalls.map(({ targetText }) => targetText)).toEqual(['Time'])
    const cellCalls = contentFadeCallsFor(motionBrowser, 'table').filter(
      ({ targetTag }) => targetTag === 'TD',
    )
    expect(cellCalls.map(({ targetText }) => targetText)).toEqual(['13:00'])
    expect(
      contentFadeCallsFor(motionBrowser, 'table').filter(({ targetTag }) => targetTag === 'TR'),
    ).toEqual([])
  })

  it('fades a changed Stat value without fading its label or Atom region', () => {
    const motionBrowser = installMotionBrowser(false)
    const statTree = AtomNodeSchema.parse({
      id: 'status-stat',
      type: 'Stat',
      binding: 'status',
      props: { label: 'Status' },
    })
    const view = render(renderNode(statTree, { state: { status: 'Waiting' }, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(statTree, {
        state: { status: 'Ready' },
        dispatch: vi.fn(),
        motion: { update: { key: 'status-patch', atomIds: ['status-stat'] } },
      }),
    )

    const statCalls = motionBrowser.calls.filter(({ nodeId }) => nodeId === 'status-stat')
    expect(statCalls.map(({ contentKey }) => contentKey)).toEqual([null, 'value'])
    expect(statCalls[0]?.keyframes).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ opacity: 0 })]),
    )
    expect(statCalls[1]).toMatchObject({
      targetText: 'Ready',
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      options: {
        duration: catalogTokens.light.motion.entranceDurationMs,
        easing: catalogTokens.light.motion.entranceEasing,
      },
    })
    expect(statCalls.some(({ targetText }) => targetText === 'Status')).toBe(false)
  })

  it('targets changed content inside every stateful control Atom', () => {
    const motionBrowser = installMotionBrowser(false)
    const controlsTree = AtomNodeSchema.parse({
      id: 'controls-root',
      type: 'Box',
      children: [
        { id: 'check', type: 'Checkbox', binding: 'checked', props: { label: 'Done' } },
        { id: 'date', type: 'DatePicker', binding: 'date', props: { label: 'Date' } },
        {
          id: 'select',
          type: 'Select',
          binding: 'priority',
          props: { label: 'Priority', options: ['low', 'high'] },
        },
        {
          id: 'radio',
          type: 'RadioGroup',
          binding: 'cadence',
          props: { label: 'Cadence', options: ['daily', 'weekly'] },
        },
        { id: 'input', type: 'Input', binding: 'title', props: { label: 'Title' } },
        { id: 'textarea', type: 'Textarea', binding: 'notes', props: { label: 'Notes' } },
        {
          id: 'automation',
          type: 'Automation',
          binding: 'enabled',
          props: { label: 'Reminder', schedule: 'Daily' },
        },
      ],
    })
    const before = {
      checked: false,
      date: '2026-08-20',
      priority: 'low',
      cadence: 'daily',
      title: 'Before',
      notes: 'Before notes',
      enabled: false,
    }
    const after = {
      checked: true,
      date: '2026-08-21',
      priority: 'high',
      cadence: 'weekly',
      title: 'After',
      notes: 'After notes',
      enabled: true,
    }
    const view = render(renderNode(controlsTree, { state: before, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    const atomIds = ['check', 'date', 'select', 'radio', 'input', 'textarea', 'automation']
    view.rerender(
      renderNode(controlsTree, {
        state: after,
        dispatch: vi.fn(),
        motion: { update: { key: 'controls-patch', atomIds } },
      }),
    )

    expect(contentKeysFor(motionBrowser, 'check')).toEqual(['value'])
    expect(contentKeysFor(motionBrowser, 'date')).toEqual(['value'])
    expect(contentKeysFor(motionBrowser, 'select')).toEqual(['value'])
    expect(contentKeysFor(motionBrowser, 'radio')).toEqual(['option:daily', 'option:weekly'])
    expect(contentKeysFor(motionBrowser, 'input')).toEqual(['value'])
    expect(contentKeysFor(motionBrowser, 'textarea')).toEqual(['value'])
    expect(contentKeysFor(motionBrowser, 'automation')).toEqual(['value'])
  })

  it('fades only a newly added Select option when its selected value stays unchanged', () => {
    const motionBrowser = installMotionBrowser(false)
    const before = AtomNodeSchema.parse({
      id: 'priority',
      type: 'Select',
      binding: 'priority',
      props: { label: 'Priority', options: ['low', 'high'] },
    })
    const after = AtomNodeSchema.parse({
      ...before,
      props: { label: 'Priority', options: ['low', 'high', 'urgent'] },
    })
    const state = { priority: 'low' }
    const view = render(renderNode(before, { state, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(after, {
        state,
        dispatch: vi.fn(),
        motion: { update: { key: 'option-patch', atomIds: ['priority'] } },
      }),
    )

    expect(contentKeysFor(motionBrowser, 'priority')).toEqual(['option:urgent'])
  })

  it('targets only changed content inside Progress and Chart Atoms', () => {
    const motionBrowser = installMotionBrowser(false)
    const dataTree = AtomNodeSchema.parse({
      id: 'data-root',
      type: 'Box',
      children: [
        { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Progress' } },
        { id: 'chart', type: 'Chart', binding: 'points', props: { label: 'Weekly values' } },
      ],
    })
    const view = render(
      renderNode(dataTree, {
        state: {
          progress: 0.25,
          points: [
            { label: 'Mon', value: 2 },
            { label: 'Tue', value: 4 },
            { label: 'Thu', value: 10 },
          ],
        },
        dispatch: vi.fn(),
      }),
    )
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(dataTree, {
        state: {
          progress: 0.75,
          points: [
            { label: 'Mon', value: 2 },
            { label: 'Tue', value: 6 },
            { label: 'Wed', value: 3 },
            { label: 'Thu', value: 10 },
          ],
        },
        dispatch: vi.fn(),
        motion: { update: { key: 'data-patch', atomIds: ['progress', 'chart'] } },
      }),
    )

    expect(contentKeysFor(motionBrowser, 'progress')).toEqual(['value', 'bar'])
    expect(contentKeysFor(motionBrowser, 'chart')).toEqual(['point:Tue', 'point:Wed'])
  })

  it('fades changed prop-driven content across the catalog', () => {
    const motionBrowser = installMotionBrowser(false)
    const before = AtomNodeSchema.parse({
      id: 'content-root',
      type: 'Box',
      children: [
        { id: 'title-content', type: 'Title', props: { text: 'Before title' } },
        { id: 'text-content', type: 'Text', props: { text: 'Before text' } },
        { id: 'caption-content', type: 'Caption', props: { text: 'Before caption' } },
        { id: 'label-content', type: 'Label', props: { text: 'Before label' } },
        { id: 'button-content', type: 'Button', props: { label: 'Before button' } },
        { id: 'badge-content', type: 'Badge', props: { text: 'Before badge' } },
        { id: 'icon-content', type: 'Icon', props: { name: 'clock', label: 'Before icon' } },
        { id: 'image-content', type: 'Image', props: { alt: 'Before image' } },
      ],
    })
    const after = AtomNodeSchema.parse({
      ...before,
      children: [
        { id: 'title-content', type: 'Title', props: { text: 'After title' } },
        { id: 'text-content', type: 'Text', props: { text: 'After text' } },
        { id: 'caption-content', type: 'Caption', props: { text: 'After caption' } },
        { id: 'label-content', type: 'Label', props: { text: 'After label' } },
        { id: 'button-content', type: 'Button', props: { label: 'After button' } },
        { id: 'badge-content', type: 'Badge', props: { text: 'After badge' } },
        { id: 'icon-content', type: 'Icon', props: { name: 'check', label: 'After icon' } },
        {
          id: 'image-content',
          type: 'Image',
          props: { alt: 'After image', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' },
        },
      ],
    })
    const view = render(renderNode(before, { state: {}, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0
    const atomIds = (after.children ?? []).map(({ id }) => id)

    view.rerender(
      renderNode(after, {
        state: {},
        dispatch: vi.fn(),
        motion: { update: { key: 'content-patch', atomIds } },
      }),
    )

    for (const atomId of atomIds) {
      expect(contentKeysFor(motionBrowser, atomId), atomId).toEqual(['content'])
    }
  })

  it('targets changed paragraphs and ListItem fields without fading their containers', () => {
    const motionBrowser = installMotionBrowser(false)
    const before = AtomNodeSchema.parse({
      id: 'composed-root',
      type: 'Box',
      children: [
        {
          id: 'markdown',
          type: 'Markdown',
          props: { text: 'Keep this paragraph.\n\nChange this paragraph.' },
        },
        {
          id: 'list-item',
          type: 'ListItem',
          props: { label: 'Before label', detail: 'Before detail', status: 'pending' },
        },
      ],
    })
    const after = AtomNodeSchema.parse({
      ...before,
      children: [
        {
          id: 'markdown',
          type: 'Markdown',
          props: {
            text: 'Keep this paragraph.\n\nChanged paragraph.\n\nAdded paragraph.',
          },
        },
        {
          id: 'list-item',
          type: 'ListItem',
          props: { label: 'After label', detail: 'After detail', status: 'done' },
        },
      ],
    })
    const view = render(renderNode(before, { state: {}, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(after, {
        state: {},
        dispatch: vi.fn(),
        motion: { update: { key: 'composed-patch', atomIds: ['markdown', 'list-item'] } },
      }),
    )

    expect(
      contentFadeCallsFor(motionBrowser, 'markdown').map(({ targetText }) => targetText),
    ).toEqual(['Changed paragraph.', 'Added paragraph.'])
    expect(contentKeysFor(motionBrowser, 'list-item')).toEqual(['label', 'detail', 'content'])
  })

  it('keeps descendant content keys isolated when a parent region is updated', () => {
    const motionBrowser = installMotionBrowser(false)
    const before = AtomNodeSchema.parse({
      id: 'parent-region',
      type: 'Box',
      children: [
        { id: 'left-content', type: 'Text', props: { text: 'Left stays' } },
        { id: 'right-content', type: 'Text', props: { text: 'Right before' } },
      ],
    })
    const after = AtomNodeSchema.parse({
      ...before,
      children: [
        { id: 'left-content', type: 'Text', props: { text: 'Left stays' } },
        { id: 'right-content', type: 'Text', props: { text: 'Right after' } },
      ],
    })
    const view = render(renderNode(before, { state: {}, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(after, {
        state: {},
        dispatch: vi.fn(),
        motion: { update: { key: 'parent-patch', atomIds: ['parent-region'] } },
      }),
    )

    expect(
      contentFadeCallsFor(motionBrowser, 'right-content').map(({ targetText }) => targetText),
    ).toEqual(['Right after'])
    expect(contentFadeCallsFor(motionBrowser, 'left-content')).toEqual([])
  })

  it('marks a newly added patch target after its entrance', () => {
    const motionBrowser = installMotionBrowser(false)
    const view = render(renderNode(tree, { state: { milk: true }, dispatch: vi.fn() }))
    const withNewCaption = AtomNodeSchema.parse({
      ...tree,
      children: [
        ...(tree.children ?? []),
        { id: 'new-caption', type: 'Caption', props: { text: 'Just added' } },
      ],
    })

    view.rerender(
      renderNode(withNewCaption, {
        state: { milk: true },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-add', atomIds: ['new-caption'] } },
      }),
    )

    expect(motionCalls(motionBrowser).slice(-2)).toEqual([
      {
        nodeId: 'new-caption',
        delay: 135,
        duration: catalogTokens.light.motion.entranceDurationMs,
        easing: catalogTokens.light.motion.entranceEasing,
      },
      {
        nodeId: 'new-caption',
        delay: undefined,
        duration: catalogTokens.light.motion.updateFeedbackDurationMs,
        easing: catalogTokens.light.motion.entranceEasing,
      },
    ])
  })

  it('leaves an updated region at its own rendered opacity', () => {
    const motionBrowser = installMotionBrowser(false)
    const hiddenTransitionTree = AtomNodeSchema.parse({
      ...tree,
      children: (tree.children ?? []).map((child) =>
        child.id === 'weird' ? { ...child, props: { visible: false } } : child,
      ),
    })
    const view = render(
      renderNode(hiddenTransitionTree, { state: { milk: true }, dispatch: vi.fn() }),
    )

    view.rerender(
      renderNode(hiddenTransitionTree, {
        state: { milk: true },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-hidden', atomIds: ['weird'] } },
      }),
    )

    const keyframes = motionBrowser.calls.at(-1)?.keyframes
    if (!Array.isArray(keyframes)) throw new Error('array keyframes are required')
    expect(keyframes.map(({ opacity }) => opacity)).toEqual([undefined, undefined, undefined])
  })

  it('fades Transition content only when its rendered visibility changes', () => {
    const motionBrowser = installMotionBrowser(false)
    const getComputedStyle = window.getComputedStyle
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudoElement) => {
      const styles = getComputedStyle(element, pseudoElement)
      Object.defineProperty(styles, 'opacity', { configurable: true, value: '0' })
      return styles
    })
    const hidden = AtomNodeSchema.parse({
      id: 'transition',
      type: 'Transition',
      props: { visible: false },
      children: [{ id: 'transition-copy', type: 'Text', props: { text: 'Stable copy' } }],
    })
    const visible = AtomNodeSchema.parse({ ...hidden, props: { visible: true } })
    const view = render(renderNode(hidden, { state: {}, dispatch: vi.fn() }))
    motionBrowser.calls.length = 0

    view.rerender(
      renderNode(visible, {
        state: {},
        dispatch: vi.fn(),
        motion: { update: { key: 'visibility-patch', atomIds: ['transition'] } },
      }),
    )

    expect(contentKeysFor(motionBrowser, 'transition')).toEqual(['content'])
    expect(contentFadeCallsFor(motionBrowser, 'transition')[0]?.keyframes).toEqual([
      { opacity: 0.4 },
      { opacity: 1 },
    ])
    expect(contentFadeCallsFor(motionBrowser, 'transition-copy')).toEqual([])
  })

  it('does not replay entrance when a persistent Atom moves between parents', () => {
    const motionBrowser = installMotionBrowser(false)
    const beforeMove = AtomNodeSchema.parse({
      id: 'move-root',
      type: 'Row',
      children: [
        {
          id: 'left',
          type: 'Col',
          children: [{ id: 'moving', type: 'Text', props: { text: 'Keep moving' } }],
        },
        { id: 'right', type: 'Col' },
      ],
    })
    const afterMove = AtomNodeSchema.parse({
      ...beforeMove,
      children: [
        { id: 'left', type: 'Col' },
        {
          id: 'right',
          type: 'Col',
          children: [{ id: 'moving', type: 'Text', props: { text: 'Keep moving' } }],
        },
      ],
    })
    const view = render(renderNode(beforeMove, { state: {}, dispatch: vi.fn() }))
    const entranceCallCount = motionBrowser.animate.mock.calls.length

    view.rerender(renderNode(afterMove, { state: {}, dispatch: vi.fn() }))

    expect(motionBrowser.animate).toHaveBeenCalledTimes(entranceCallCount)
  })

  it('renders the full v1 Atom catalog in light and dark without UnknownAtom fallback', () => {
    const motionBrowser = installMotionBrowser(false)
    const types = new Set(collectTypes(catalogShowcaseSurface.tree))
    expect(types).toEqual(new Set(atomTypes))

    const light = render(
      renderNode(catalogShowcaseSurface.tree, {
        state: catalogShowcaseSurface.state,
        dispatch: vi.fn(),
        theme: 'light',
      }),
    )
    expect(light.queryByTestId('unknown-atom')).toBeNull()
    expect(light.container.querySelector('[data-veduta-theme="light"]')).not.toBeNull()
    expect(new Set(motionCalls(motionBrowser).map(({ nodeId }) => nodeId))).toEqual(
      new Set(collectIds(catalogShowcaseSurface.tree)),
    )

    light.unmount()

    const dark = render(
      renderNode(catalogShowcaseSurface.tree, {
        state: catalogShowcaseSurface.state,
        dispatch: vi.fn(),
        theme: 'dark',
      }),
    )
    expect(dark.queryByTestId('unknown-atom')).toBeNull()
    expect(dark.container.querySelector('[data-veduta-theme="dark"]')).not.toBeNull()
  })

  it('gives interactive Atoms accessible controls and dispatches declared actions', () => {
    const dispatch = vi.fn()
    render(
      renderNode(catalogShowcaseSurface.tree, {
        state: catalogShowcaseSurface.state,
        dispatch,
      }),
    )

    fireEvent.click(screen.getByRole('checkbox', { name: /milk/i }))
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-07-04' } })
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } })
    fireEvent.click(screen.getByRole('radio', { name: /weekly/i }))
    fireEvent.change(screen.getByLabelText('Title input'), { target: { value: 'Updated' } })
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Bring fruit' } })
    fireEvent.click(screen.getByRole('switch', { name: /water reminder/i }))

    expect(
      (screen.getByRole('button', { name: /regenerate/i }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(
      screen.getByRole('progressbar', { name: /weekly progress/i }).getAttribute('aria-valuenow'),
    ).toBe('72')
    expect(dispatch.mock.calls.map((call) => [call[0].id, call[1], call[2]])).toEqual([
      ['checkbox-milk', 'toggle', false],
      ['date-picker', 'change', '2026-07-04'],
      ['priority-select', 'change', 'high'],
      ['cadence-radio', 'change', 'weekly'],
      ['title-input', 'change', 'Updated'],
      ['notes-textarea', 'change', 'Bring fruit'],
      ['water-automation', 'toggle', false],
    ])
  })
})

function collectTypes(node: AtomNode): AtomNode['type'][] {
  return [node.type, ...(node.children ?? []).flatMap(collectTypes)]
}

function collectIds(node: AtomNode): string[] {
  return [node.id, ...(node.children ?? []).flatMap(collectIds)]
}

function installMotionBrowser(reducedMotion: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: reducedMotion,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  )
  const calls: Array<{
    nodeId: string
    contentKey: string | null
    targetTag: string
    targetText: string
    keyframes: Keyframe[] | PropertyIndexedKeyframes
    options: KeyframeAnimationOptions
  }> = []
  const animate = vi.fn(function (
    this: Element,
    keyframes: Keyframe[] | PropertyIndexedKeyframes,
    options?: number | KeyframeAnimationOptions,
  ) {
    if (!options || typeof options === 'number') throw new Error('motion options are required')
    calls.push({
      nodeId:
        this.getAttribute('data-veduta-atom-id') ??
        this.closest('[data-veduta-atom-id]')?.getAttribute('data-veduta-atom-id') ??
        '',
      contentKey: this.getAttribute('data-veduta-motion-content-key'),
      targetTag: this.tagName,
      targetText: this.textContent ?? '',
      keyframes,
      options,
    })
    return { cancel: vi.fn() }
  })
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    value: animate,
  })
  return { animate, calls }
}

function motionCalls({ calls }: ReturnType<typeof installMotionBrowser>) {
  return calls.map(({ nodeId, options }) => {
    return {
      nodeId,
      delay: options.delay,
      duration: options.duration,
      easing: options.easing,
    }
  })
}

function contentKeysFor(
  { calls }: ReturnType<typeof installMotionBrowser>,
  atomId: string,
): Array<string> {
  return calls.flatMap((call) =>
    call.nodeId === atomId && call.contentKey !== null && hasOpacityKeyframe(call.keyframes)
      ? [call.contentKey]
      : [],
  )
}

function contentFadeCallsFor({ calls }: ReturnType<typeof installMotionBrowser>, atomId: string) {
  return calls.filter((call) => call.nodeId === atomId && hasOpacityKeyframe(call.keyframes))
}

function hasOpacityKeyframe(keyframes: Keyframe[] | PropertyIndexedKeyframes): boolean {
  return Array.isArray(keyframes) && keyframes.some(({ opacity }) => opacity !== undefined)
}
