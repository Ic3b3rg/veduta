import { z } from 'zod'

export const DEMO_STORAGE_KEY = 'veduta.public-demo.v1'
const DemoStateSchema = z
  .object({
    stage: z.enum(['start', 'proposed', 'rejected', 'space', 'surface', 'edited']),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type DemoState = z.infer<typeof DemoStateSchema>
export type DemoAction = 'propose' | 'accept' | 'reject' | 'create' | 'edit' | 'reset'

export function initialDemoState(): DemoState {
  return { stage: 'start', updatedAt: new Date().toISOString() }
}

export function transitionDemo(state: DemoState, action: DemoAction): DemoState {
  if (action === 'reset') return initialDemoState()
  if (action === 'propose' && (state.stage === 'start' || state.stage === 'rejected'))
    return { stage: 'proposed', updatedAt: new Date().toISOString() }
  if (action === 'reject' && state.stage === 'proposed')
    return { stage: 'rejected', updatedAt: new Date().toISOString() }
  if (action === 'accept' && state.stage === 'proposed') return { ...state, stage: 'space' }
  if (action === 'create') {
    if (state.stage === 'start' || state.stage === 'proposed' || state.stage === 'rejected')
      throw new Error('Create Work first by accepting its proposal.')
    if (state.stage === 'space') return { stage: 'surface', updatedAt: new Date().toISOString() }
  }
  if (action === 'edit') {
    if (state.stage !== 'surface' && state.stage !== 'edited')
      throw new Error('Prepare the Weekly plan first.')
    if (state.stage === 'surface') return { stage: 'edited', updatedAt: new Date().toISOString() }
  }
  return state
}

export function readDemoState(storage: Pick<Storage, 'getItem'>): {
  state: DemoState
  warning: string | null
} {
  try {
    const raw = storage.getItem(DEMO_STORAGE_KEY)
    return {
      state: raw ? DemoStateSchema.parse(JSON.parse(raw)) : initialDemoState(),
      warning: null,
    }
  } catch {
    return {
      state: initialDemoState(),
      warning:
        'This demo could not be restored from browser storage. Start again, or allow local storage in this browser.',
    }
  }
}

export function saveDemoState(state: DemoState, storage: Pick<Storage, 'setItem'>): void {
  storage.setItem(DEMO_STORAGE_KEY, JSON.stringify(DemoStateSchema.parse(state)))
}
