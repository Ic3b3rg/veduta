import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import {
  textIn,
  toolCallIn,
  toolResultContext,
  userContext,
} from './mock-chat-model.test-helpers.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'

const REQUEST = 'show composed surface demo'

it('creates a composed Surface then replaces one canonical Pending node through versioned authoring', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-composed-surface-'))
  const store = new Store({ rootDir })
  try {
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    const tools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: space.id,
    })
    const responder = createMockChatResponder({ progressiveDelayMs: 0 })
    const results: Array<{ toolName: string; content: string }> = []
    let context = userContext(REQUEST)
    for (let step = 0; step < 5; step++) {
      const call = toolCallIn(await responder(context, { callCount: step }))
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
      context = toolResultContext(REQUEST, results)
      if (call.name === 'create_surface') {
        const pending = store
          .readAuthorableSurface(space.id, 'srf-composed-demo')
          .surface.tree.children?.find((node) => node.id === 'composed-preview')
        expect(pending?.type).toBe('Pending')
        expect(pending?.props?.['startedAt']).toEqual(expect.any(String))
      }
    }
    const surface = store.readAuthorableSurface(space.id, 'srf-composed-demo').surface
    const replaced = surface.tree.children?.filter((node) => node.id === 'composed-preview')
    expect(replaced).toHaveLength(1)
    expect(replaced?.[0]?.type).toBe('Text')
    expect(replaced?.[0]?.props?.['text']).toBe('Comparison preview ready')
    expect(textIn(await responder(context, { callCount: results.length }))).toBe(
      'Saved Composed Surface: Comparison preview ready.',
    )
  } finally {
    store.close()
    rmSync(rootDir, { recursive: true, force: true })
  }
})

it('does not announce a completed replacement when versioned authoring fails', async () => {
  const responder = createMockChatResponder({ progressiveDelayMs: 0 })
  const context = toolResultContext(REQUEST, [
    { toolName: 'list_surfaces', content: '[]' },
    { toolName: 'create_surface', content: 'created Surface srf-composed-demo' },
    { toolName: 'patch_tree', content: 'tree version conflict', isError: true },
  ])
  const reply = textIn(await responder(context, { callCount: 3 }))
  expect(reply).toContain('could not be completed')
  expect(reply).not.toContain('ready')
})
