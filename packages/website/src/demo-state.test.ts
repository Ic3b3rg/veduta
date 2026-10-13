import { expect, it } from 'vitest'
import {
  initialDemoState,
  transitionDemo,
  readDemoState,
  saveDemoState,
  DEMO_STORAGE_KEY,
} from './demo-state.ts'

it('requires Space confirmation before authoring and preserves the edited stage on reload', () => {
  const initial = initialDemoState()
  expect(() => transitionDemo(initial, 'create')).toThrow('Create Work first')
  const proposed = transitionDemo(initial, 'propose')
  expect(proposed.stage).toBe('proposed')
  expect(() => transitionDemo(proposed, 'edit')).toThrow('Prepare the Weekly plan first')
  const space = transitionDemo(proposed, 'accept')
  const surface = transitionDemo(space, 'create')
  const edited = transitionDemo(surface, 'edit')
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
  }
  saveDemoState(edited, storage)
  expect(readDemoState(storage)).toEqual({ state: edited, warning: null })
  expect(values.has('veduta.authToken')).toBe(false)
})

it('recovers malformed local demo data visibly and reports blocked persistence', () => {
  const broken = { getItem: () => '{"stage":"executing-shell"}' }
  const recovered = readDemoState(broken)
  expect(recovered.state.stage).toBe('start')
  expect(recovered.warning).toContain('could not be restored')
  const blocked = {
    setItem: () => {
      throw new Error('Storage blocked')
    },
  }
  expect(() => saveDemoState(initialDemoState(), blocked)).toThrow('Storage blocked')
  expect(DEMO_STORAGE_KEY).toBe('veduta.public-demo.v1')
})
