import { inputSetPlan, formSetPlan } from './action-builders.ts'
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
      actions: [
        { name: 'toggle', path: 'fast', plan: inputSetPlan('milk', { type: 'boolean' }) },
        { name: 'explain' },
      ],
    },
  ],
})

const formTree = AtomNodeSchema.parse({
  id: 'profile-form',
  type: 'Form',
  props: { label: 'Profile', submitLabel: 'Save' },
  actions: [{ name: 'submit', path: 'fast', plan: formSetPlan(['name', 'bio']) }],
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
    expect(action).toEqual({
      name: 'toggle',
      path: 'fast',
      plan: inputSetPlan('milk', { type: 'boolean' }),
    })
  })

  it('does not resolve agent-path actions as fast', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'explain')).toBeUndefined()
  })

  it('does not resolve undeclared actions or unknown nodes', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'delete')).toBeUndefined()
    expect(findDeclaredFastAction(tree, 'ghost', 'toggle')).toBeUndefined()
  })
})

describe('findDeclaredFastAction', () => {
  it('resolves the atomic submit declaration with all state keys', () => {
    expect(findDeclaredFastAction(formTree, 'profile-form', 'submit')).toEqual({
      name: 'submit',
      path: 'fast',
      plan: formSetPlan(['name', 'bio']),
    })
  })

  it('resolves both control and Form plans through the same declaration lookup', () => {
    expect(findDeclaredFastAction(tree, 'milk', 'toggle')?.plan.inputs).toEqual({
      value: { type: 'boolean' },
    })
  })
})
