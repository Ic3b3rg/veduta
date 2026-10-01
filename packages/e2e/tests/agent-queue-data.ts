import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { AGENT_ACTION_QUEUE_CAPACITY } from '../../protocol/src/index.ts'
import { AGENT_ACTION_SURFACE_ID } from './agent-action-surface.ts'

/** Fill only this journey's disposable Space through the public Action contract. */
export function fillAgentQueue(baseDir: string): string[] {
  const store = new Store({ rootDir: join(baseDir, 'data') })
  try {
    return Array.from({ length: AGENT_ACTION_QUEUE_CAPACITY }, () => {
      const result = store.invokeSurfaceAction(AGENT_ACTION_SURFACE_ID, {
        nodeId: 'complete-demo',
        name: 'complete_demo',
        idempotencyKey: randomUUID(),
      })
      if (result.path !== 'agent') throw new Error('Agent turn required')
      return result.turn.id
    })
  } finally {
    store.close()
  }
}

export function releaseAgentQueue(baseDir: string, turns: string[]): void {
  const store = new Store({ rootDir: join(baseDir, 'data') })
  try {
    for (const id of turns)
      store.finishAgentTurn(id, { error: 'Disposable capacity fixture settled' })
  } finally {
    store.close()
  }
}
