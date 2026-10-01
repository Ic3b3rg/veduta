import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema } from '@veduta/protocol'
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

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each([
  { actionName: 'complete_demo', request: 'Complete the Agent action demo', failed: false },
  { actionName: 'fail_demo', request: 'Try an invalid Agent action demo', failed: true },
])(
  'the mock $actionName uses current Surface state and reports only its canonical tool outcome',
  async (scenario) => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-agent-action-'))
    roots.push(rootDir)
    const store = new Store({ rootDir })
    try {
      const space = store.spacesEngine.createSpace({ name: 'Work' })
      const surface = store.createSurface(
        SurfaceSchema.parse({
          id: 'srf-unrelated-demo',
          spaceId: space.id,
          title: 'Agent action demo',
          state: { result: 'Waiting', records: [{ id: 'kept-record', label: 'Kept' }] },
          freshness: { updatedAt: '2026-10-01T12:00:00.000Z', updatedBy: 'agent' },
          tree: {
            id: 'demo-root',
            type: 'Col',
            children: [
              { id: 'result-stat', type: 'Stat', binding: 'result', props: { label: 'Result' } },
              {
                id: 'records-table',
                type: 'Table',
                binding: 'records',
                props: { columns: ['label'] },
              },
              {
                id: 'demo-button',
                type: 'Button',
                props: { label: 'Complete demo' },
                actions: [
                  {
                    name: scenario.actionName,
                    path: 'agent',
                    payload: { request: scenario.request },
                  },
                ],
              },
            ],
          },
        }),
        'agent',
      )
      const request = `Surface Action request\n${JSON.stringify({
        actionName: scenario.actionName,
        surfaceId: surface.id,
        atomId: 'demo-button',
        payload: { request: scenario.request },
      })}\nCurrent Surface snapshot follows.`
      const tools = createFocusedSurfaceTools({
        store,
        templateEngine: new TemplateEngine({ store }),
        spaceId: space.id,
      })
      const responder = createMockChatResponder({})
      const results: Array<{ toolName: string; content: string; isError?: boolean }> = []
      let context = userContext(request)
      for (let step = 0; step < 3; step++) {
        const message = await responder(context, { callCount: step })
        const call = toolCallIn(message)
        expect(call.name).toBe(['list_surfaces', 'read_surface', 'patch_state'][step])
        const tool = tools.find((candidate) => candidate.name === call.name)
        if (!tool) throw new Error(`Missing ${call.name}`)
        if (scenario.failed && step === 2) {
          expect(textIn(message)).toBe('The Agent action is complete.')
        }
        try {
          const result = await tool.handler(
            tool.schema.parse(call.arguments),
            fromPartial<ToolContext>({
              origin: 'trusted:user',
              origins: ['trusted:user'],
              taint: new TurnTaintAccumulator(['trusted:user']),
            }),
          )
          results.push({ toolName: call.name, content: result.content })
        } catch (failure) {
          results.push({ toolName: call.name, content: String(failure), isError: true })
        }
        context = toolResultContext(request, results)
      }
      const reply = textIn(await responder(context, { callCount: 3 }))
      const updated = store.readAuthorableSurface(space.id, surface.id).surface
      expect(Boolean(results.at(-1)?.isError)).toBe(scenario.failed)
      expect(updated.state['result']).toBe(scenario.failed ? 'Waiting' : 'Completed')
      expect(updated.state['records']).toEqual(
        scenario.failed
          ? [{ id: 'kept-record', label: 'Kept' }]
          : [
              { id: 'kept-record', label: 'Kept' },
              { id: 'agent-demo-2', label: 'Completed' },
            ],
      )
      expect(reply).toContain(scenario.failed ? 'not completed' : 'action completed')
    } finally {
      store.close()
    }
  },
)
