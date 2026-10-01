import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema } from '@veduta/protocol'
import { expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { mockWeightTrackerInput } from './mock-chart-fixture.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import {
  textIn,
  toolCallIn,
  toolResultContext,
  userContext,
} from './mock-chat-model.test-helpers.ts'
import { Store } from './store.ts'
import { SurfaceChatConfirmation } from './surface-chat-confirmation.ts'
import { TemplateEngine } from './template-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'

const REQUEST = 'show invalid Surface authoring demo'

it('attempts invalid authoring through real tools while canonical state and confirmation remain honest', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-invalid-authoring-'))
  const store = new Store({ rootDir })
  try {
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    const surface = store.createSurface(
      SurfaceSchema.parse({
        ...mockWeightTrackerInput(),
        spaceId: space.id,
        freshness: { updatedAt: new Date().toISOString(), updatedBy: 'agent' },
      }),
      'agent',
    )
    const before = store.snapshot()
    const eventsBefore = store.spacesEngine.readRecent(space.id)
    const tools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: space.id,
    })
    const responder = createMockChatResponder({})
    const confirmation = new SurfaceChatConfirmation((id) => store.getSurface(id))
    const results: Array<{ toolName: string; content: string; isError?: boolean }> = []
    let context = userContext(REQUEST)
    for (const name of ['list_surfaces', 'read_surface', 'patch_tree']) {
      const call = toolCallIn(await responder(context, { callCount: results.length }))
      expect(call.name).toBe(name)
      const tool = tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`Missing ${call.name}`)
      confirmation.observe({
        type: 'tool-start',
        toolCallId: call.id,
        toolName: call.name,
        input: call.arguments,
      })
      let content: string
      let details: unknown
      let isError = false
      try {
        const result = await tool.handler(
          tool.schema.parse(call.arguments),
          fromPartial<ToolContext>({
            origin: 'trusted:user',
            origins: ['trusted:user'],
            taint: new TurnTaintAccumulator(['trusted:user']),
          }),
        )
        content = result.content
        details = result.details
      } catch (error) {
        if (name !== 'patch_tree') throw error
        content = error instanceof Error ? error.message : String(error)
        isError = true
      }
      confirmation.observe({
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        content,
        details,
        isError,
      })
      results.push({ toolName: call.name, content, isError })
      context = toolResultContext(REQUEST, results)
    }
    expect(results.at(-1)).toMatchObject({ toolName: 'patch_tree', isError: true })
    expect(results.at(-1)?.content).toContain('cssWidth')
    expect(store.snapshot()).toEqual(before)
    expect(store.getSurface(surface.id)).toEqual(surface)
    expect(store.spacesEngine.readRecent(space.id)).toEqual(eventsBefore)
    const providerText = textIn(await responder(context, { callCount: results.length }))
    expect(providerText).toContain('All requested changes were saved.')
    expect(confirmation.feedback()).toContain('A Surface change was not saved:')
    expect(confirmation.feedback()).not.toContain(providerText)
  } finally {
    store.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
})
