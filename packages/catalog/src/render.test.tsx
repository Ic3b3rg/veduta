// @vitest-environment jsdom
import { AtomNodeSchema, type AtomNode } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderNode } from './render.tsx'

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
    render(renderNode(tree, { state: {}, dispatch: vi.fn() }))
    expect(screen.getByTestId('unknown-atom').textContent).toContain('Transition')
  })
})
