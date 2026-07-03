import { describe, expect, it } from 'vitest'
import { AtomNodeSchema } from './atom.ts'
import { findAtom, findDeclaredFastAction } from './tree.ts'

const tree = AtomNodeSchema.parse({
  id: 'root',
  type: 'Box',
  children: [
    { id: 'title', type: 'Title', props: { text: 'Groceries' } },
    {
      id: 'milk',
      type: 'Checkbox',
      binding: 'milk',
      actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }, { name: 'explain' }],
    },
  ],
})

describe('findAtom', () => {
  it('finds nested nodes and returns undefined for unknown ids', () => {
    expect(findAtom(tree, 'milk')?.type).toBe('Checkbox')
    expect(findAtom(tree, 'nope')).toBeUndefined()
  })
})

describe('findDeclaredFastAction', () => {
  it('resolves a declared fast action with its stateKey', () => {
    const action = findDeclaredFastAction(tree, 'milk', 'toggle')
    expect(action).toEqual({ name: 'toggle', path: 'fast', stateKey: 'milk' })
  })

  it('does not resolve agent-path actions as fast', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'explain')).toBeUndefined()
  })

  it('does not resolve undeclared actions or unknown nodes', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'delete')).toBeUndefined()
    expect(findDeclaredFastAction(tree, 'ghost', 'toggle')).toBeUndefined()
  })
})
