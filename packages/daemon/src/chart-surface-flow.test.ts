import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import { textIn, toolCallIn, toolResultContext } from './mock-chat-model.test-helpers.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'

const roots: string[] = []
const stores: Store[] = []
const at = new Date('2026-09-01T10:00:00.000Z')
const context = fromPartial<ToolContext>({
  toolCallId: 'chart-regression',
  origin: 'trusted:user',
  taint: new TurnTaintAccumulator(['trusted:user']),
})

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function executeTool(tools: ToolDef[], name: string, input: unknown) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing Surface tool ${name}`)
  return tool.handler(tool.schema.parse(input), context)
}

describe('Chart Surface tool journey', () => {
  it('refuses invalid Chart creation and a whole invalid state patch before either persists', async () => {
    const store = new Store()
    stores.push(store)
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    const tools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: space.id,
    })
    const responder = createMockChatResponder({ now: () => at })
    const creation = toolCallIn(
      await responder(
        toolResultContext('create a weight tracker in Health', [
          { toolName: 'enter_space', content: '# Active Space\n\nHealth (health)' },
        ]),
        { callCount: 1 },
      ),
    )
    const before = store.latestSurfaceCursor()
    await expect(
      executeTool(tools, creation.name, {
        ...creation.arguments,
        state: {
          currentWeight: '74 kg',
          weightRecords: [{ occurredAt: at.toISOString(), weight: '74' }],
        },
      }),
    ).rejects.toThrow('Chart y-values must be finite numbers')
    expect(store.getSurface('srf-health-weight-tracker')).toBeUndefined()
    expect(store.latestSurfaceCursor()).toBe(before)

    await executeTool(tools, creation.name, creation.arguments)
    const canonical = store.getSurface('srf-health-weight-tracker')
    const createdCursor = store.latestSurfaceCursor()
    await expect(
      executeTool(tools, 'patch_state', {
        surfaceId: 'srf-health-weight-tracker',
        operations: [
          { target: 'state', op: 'replace', path: '/currentWeight', value: '74 kg' },
          {
            target: 'state',
            op: 'replace',
            path: '/weightRecords',
            value: [{ occurredAt: at.toISOString(), weight: '74' }],
          },
        ],
      }),
    ).rejects.toThrow('Chart y-values must be finite numbers')
    expect(store.getSurface('srf-health-weight-tracker')).toEqual(canonical)
    expect(store.latestSurfaceCursor()).toBe(createdCursor)
  })

  it('records the Italian 74 kg request through validated tools and survives a Gateway restart', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-chart-flow-'))
    roots.push(rootDir)
    const store = new Store({ rootDir, now: () => at })
    stores.push(store)
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    const tools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: space.id,
    })
    const responder = createMockChatResponder({ now: () => at })
    const creation = toolCallIn(
      await responder(
        toolResultContext('create a weight tracker in Health', [
          { toolName: 'enter_space', content: '# Active Space\n\nHealth (health)' },
        ]),
        { callCount: 1 },
      ),
    )
    await executeTool(tools, creation.name, creation.arguments)
    const results: Array<{ toolName: string; content: string }> = []
    const request = 'mi sono pesato e sono 74 kg'
    let reply = ''
    for (let callCount = 0; callCount < 5; callCount++) {
      const response = await responder(toolResultContext(request, results), { callCount })
      if (response.stopReason === 'stop') {
        reply = textIn(response)
        break
      }
      const call = toolCallIn(response)
      const result = await executeTool(tools, call.name, call.arguments)
      results.push({ toolName: call.name, content: result.content })
    }

    expect(results.map((result) => result.toolName)).toEqual([
      'list_surfaces',
      'read_surface',
      'patch_state',
    ])
    expect(reply).toContain('Recorded 74 kg')
    const surface = SurfaceSchema.parse(store.getSurface('srf-health-weight-tracker'))
    expect(surface.state).toEqual({
      currentWeight: '74 kg',
      weightRecords: [{ occurredAt: '2026-09-01T10:00:00.000Z', weight: 74 }],
    })
    expect(surface.tree.children?.filter((node) => node.binding === 'weightRecords')).toHaveLength(
      2,
    )

    store.close()
    stores.splice(stores.indexOf(store), 1)
    const restarted = new Store({ rootDir, now: () => at })
    stores.push(restarted)
    expect(restarted.getSurface(surface.id)).toEqual(surface)
  })
})
