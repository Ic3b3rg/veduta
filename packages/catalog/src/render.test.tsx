// @vitest-environment jsdom
import { AtomNodeSchema, atomTypes, type AtomNode } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'
import { catalogShowcaseSurface } from './showcase.ts'

afterEach(cleanup)

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
