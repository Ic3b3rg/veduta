import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, expect, it } from 'vitest'
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

const REQUEST = 'data la mia dieta fammi una scheda per la palestra 3 giorni a settimana'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('creates complete plan content through focused Surface tools and reports the committed body', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-structured-plan-'))
  roots.push(rootDir)
  const store = new Store({ rootDir })
  try {
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    const tools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: space.id,
    })
    const responder = createMockChatResponder({})
    const results: Array<{ toolName: string; content: string }> = []
    let context = userContext(REQUEST)
    for (let step = 0; step < 4; step++) {
      const message = await responder(context, { callCount: step })
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
      context = toolResultContext(REQUEST, results)
      if (call.name === 'read_surface') break
    }
    const reply = textIn(await responder(context, { callCount: results.length }))
    const surface = store.readAuthorableSurface(space.id, 'srf-structured-plan').surface
    expect(surface.title).toBe('Gym plan — 3 days')
    const body = JSON.stringify(surface.tree)
    for (const content of [
      'Session 1 — Strength',
      'Session 2 — Upper body',
      'Session 3 — Full body',
      'Squat',
      'Row',
      'Deadlift',
      '3 × 8',
      '90 seconds',
      'Add one repetition before increasing load',
      'stop if you feel sharp pain',
    ])
      expect(body).toContain(content)
    expect(reply).toContain('Saved Gym plan — 3 days')
    expect(reply).toContain('Session 3 — Full body')
  } finally {
    store.close()
  }
})

it('does not claim plan creation after the Gateway rejects authoring', async () => {
  const responder = createMockChatResponder({})
  const context = toolResultContext(REQUEST, [
    { toolName: 'list_surfaces', content: '[]' },
    { toolName: 'create_surface', content: 'invalid Surface: unsupported props', isError: true },
  ])
  const reply = textIn(await responder(context, { callCount: 2 }))
  expect(reply).toContain('not created')
  expect(reply).not.toContain('Saved')
})
