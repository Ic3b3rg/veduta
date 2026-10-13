import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import {
  toolCallIn,
  toolResultContext,
  userContext,
  textIn,
} from './mock-chat-model.test-helpers.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'

const createRequest =
  'Prepare a weekly plan with three priorities: ship the prototype, talk to testers, and write release notes.'
const editRequest = 'Move tester interviews to Tuesday and make them the top priority.'

it('creates and edits the demo through real tools, with Events and state surviving a Store restart', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-product-demo-test-'))
  let store = new Store({ rootDir, seed: { spaces: [], surfaces: [] } })
  try {
    const space = store.spacesEngine.createSpace({ name: 'Work' })
    const responder = createMockChatResponder({})
    const run = async (request: string) => {
      const tools = createFocusedSurfaceTools({
        store,
        templateEngine: new TemplateEngine({ store }),
        spaceId: space.id,
      })
      const results: Array<{ toolName: string; content: string }> = []
      for (let step = 0; step < 8; step++) {
        const context = results.length ? toolResultContext(request, results) : userContext(request)
        const message = await responder(context, { callCount: step })
        if (message.stopReason !== 'toolUse') return textIn(message)
        const call = toolCallIn(message)
        const tool = tools.find((candidate) => candidate.name === call.name)
        if (!tool) throw new Error(`Missing ${call.name}`)
        const result = await tool.handler(
          tool.schema.parse(call.arguments),
          fromPartial<ToolContext>({
            origin: 'trusted:user',
            origins: ['trusted:user'],
            taint: new TurnTaintAccumulator(['trusted:user']),
          }),
        )
        results.push({ toolName: call.name, content: result.content })
      }
      throw new Error('The demo did not finish')
    }
    expect(await run(createRequest)).toContain('Weekly plan')
    const before = store.readAuthorableSurface(space.id, 'srf-demo-weekly-plan').surface
    expect(before.state['topPriority']).toBe('Ship the prototype')
    expect(JSON.stringify(before.state)).toContain('Thursday')
    expect(await run(editRequest)).toContain('Tuesday')
    const after = store.readAuthorableSurface(space.id, before.id).surface
    expect(after.state['topPriority']).toBe('Talk to testers')
    expect(JSON.stringify(after.state)).toContain('Tuesday')
    expect(after.tree).toEqual(before.tree)
    const events = store.spacesEngine.readRecent(space.id)
    expect(events.filter((event) => event.type.startsWith('surface.'))).toHaveLength(2)
    store.close()
    store = new Store({ rootDir, seed: { spaces: [], surfaces: [] } })
    expect(store.readAuthorableSurface(space.id, before.id).surface).toEqual(after)
    expect(store.spacesEngine.readRecent(space.id)).toEqual(events)
  } finally {
    store.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
})

it('does not claim a demo edit when the Surface is missing or a patch failed', async () => {
  const respond = createMockChatResponder({})
  for (const results of [
    [{ toolName: 'read_surface', content: 'Surface not found', isError: true }],
    [{ toolName: 'patch_state', content: 'Write rejected', isError: true }],
  ]) {
    const message = await respond(toolResultContext(editRequest, results), { callCount: 1 })
    expect(textIn(message)).toContain('not updated')
    expect(message.stopReason).not.toBe('toolUse')
  }
})
