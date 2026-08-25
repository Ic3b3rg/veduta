import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { createGlobalChatTools } from './global-chat-tools.ts'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'
import { TurnTaintAccumulator } from './taint.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-global-chat-tools-'))
  roots.push(rootDir)
  const store = new Store({ rootDir })
  ensureSystemSpace(store.spacesEngine)
  const health = store.spacesEngine.createSpace({ name: 'Health' })
  const tools = createGlobalChatTools({ store, focusedToolsFor: () => [] })
  const context = fromPartial<ToolContext>({
    toolCallId: 'call-enter',
    origin: 'trusted:user',
    origins: ['trusted:user'],
    taint: new TurnTaintAccumulator(['trusted:user']),
    contextHash: 'global-chat-tools-test',
    initiatingTurn: { clientId: 'pwa-test', turnId: 'turn-test' },
  })
  return { store, health, tools, context }
}

describe('createGlobalChatTools', () => {
  it('enters a user life-area Space by slug', async () => {
    const { health, tools, context } = harness()
    const enterSpace = tools.find((tool) => tool.name === 'enter_space')!

    const result = await enterSpace.handler(
      enterSpace.schema.parse({ spaceId: health.slug }),
      context,
    )
    expect(result).toMatchObject({ details: { space: { id: health.id } } })
  })

  it('keeps the Gateway-owned System Space outside global Agent work', () => {
    const { store, tools, context } = harness()
    const before = store.eventLog(SYSTEM_SPACE_ID).length
    const enterSpace = tools.find((tool) => tool.name === 'enter_space')!

    expect(() =>
      enterSpace.handler(enterSpace.schema.parse({ spaceId: SYSTEM_SPACE_ID }), context),
    ).toThrow(/System Space/)
    expect(store.eventLog(SYSTEM_SPACE_ID)).toHaveLength(before)
  })
})
