import { describe, expect, it } from 'vitest'
import { AtomNodeSchema } from './atom.ts'
import { findAtom, findDeclaredFastAction, findDeclaredFastFormAction } from './tree.ts'

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

const formTree = AtomNodeSchema.parse({
  id: 'profile-form',
  type: 'Form',
  props: { label: 'Profile', submitLabel: 'Save' },
  actions: [{ name: 'submit', path: 'fast', stateKeys: ['name', 'bio'] }],
  children: [
    { id: 'name', type: 'Input', binding: 'name', props: { label: 'Name' } },
    { id: 'bio', type: 'Textarea', binding: 'bio', props: { label: 'Biography' } },
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
    expect(action).toEqual({ name: 'toggle', path: 'fast', payload: {}, stateKey: 'milk' })
  })

  it('does not resolve agent-path actions as fast', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'explain')).toBeUndefined()
  })

  it('does not resolve undeclared actions or unknown nodes', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'delete')).toBeUndefined()
    expect(findDeclaredFastAction(tree, 'ghost', 'toggle')).toBeUndefined()
  })
})

describe('findDeclaredFastFormAction', () => {
  it('resolves the atomic submit declaration with all state keys', () => {
    expect(findDeclaredFastFormAction(formTree, 'profile-form', 'submit')).toEqual({
      name: 'submit',
      path: 'fast',
      payload: {},
      stateKeys: ['name', 'bio'],
    })
  })

  it('does not treat a single-key fast action as a Form submit', () => {
    expect(findDeclaredFastFormAction(tree, 'milk', 'toggle')).toBeUndefined()
  })
})
