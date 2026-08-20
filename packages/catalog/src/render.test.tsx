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
    const futureTree: AtomNode = JSON.parse('{"id":"future","type":"FutureAtom"}')
    render(renderNode(futureTree, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByTestId('unknown-atom').textContent).toContain('FutureAtom')
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

  it('fades and marks only the updated Atom region, once per patch key', () => {
    const motionBrowser = installMotionBrowser(false)
    const view = render(renderNode(tree, { state: { milk: true }, dispatch: vi.fn() }))

    view.rerender(
      renderNode(tree, {
        state: { milk: false },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-1', atomIds: ['milk'] } },
      }),
    )

    expect(motionCalls(motionBrowser)).toHaveLength(5)
    expect(motionCalls(motionBrowser).at(-1)).toMatchObject({
      nodeId: 'milk',
      delay: undefined,
      duration: 720,
    })
    expect(motionBrowser.calls.at(-1)?.keyframes).toEqual([
      { opacity: 0, outline: '0 solid #246b58', outlineOffset: '0', offset: 0 },
      {
        opacity: 1,
        outline: '4px solid #246b58',
        outlineOffset: '4px',
        offset:
          catalogTokens.light.motion.entranceDurationMs /
          catalogTokens.light.motion.updateFeedbackDurationMs,
      },
      { opacity: 1, outline: '0 solid #246b58', outlineOffset: '8px', offset: 1 },
    ])

    view.rerender(
      renderNode(tree, {
        state: { milk: true },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-1', atomIds: ['milk'] } },
      }),
    )
    expect(motionBrowser.animate).toHaveBeenCalledTimes(5)

    view.rerender(
      renderNode(tree, {
        state: { milk: false },
        dispatch: vi.fn(),
        motion: { update: { key: 'patch-2', atomIds: ['milk'] } },
      }),
    )
    expect(motionCalls(motionBrowser).at(-1)?.nodeId).toBe('milk')
    expect(motionBrowser.animate).toHaveBeenCalledTimes(6)
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

  it('fades an updated region back to its own rendered opacity', () => {
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
    expect(keyframes.map(({ opacity }) => opacity)).toEqual([0, 0.4, 0.4])
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
      nodeId: this.getAttribute('data-veduta-atom-id') ?? '',
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
