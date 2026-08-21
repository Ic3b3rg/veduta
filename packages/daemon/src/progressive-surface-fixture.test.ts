import { AtomNodeSchema, findAtom } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import {
  textIn,
  toolCallIn,
  toolResultContext,
  userContextInSpace,
} from './mock-chat-model.test-helpers.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import { PROGRESSIVE_SURFACE_REQUEST } from './progressive-surface-fixture.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'

describe('progressive Surface Loopback fixture', () => {
  it('publishes one full Pending layout, then four independently versioned fills', async () => {
    const at = new Date('2026-08-21T12:00:00.000Z')
    const store = new Store()
    const space = store.spacesEngine.createSpace({ name: 'Travel' })
    const tools = createFocusedSurfaceTools({
      store,
      templateEngine: new TemplateEngine({ store }),
      spaceId: space.id,
    })
    const responder = createMockChatResponder({ now: () => at, progressiveDelayMs: 0 })
    const results: Array<{ toolName: string; content: string }> = []
    const calls: ReturnType<typeof toolCallIn>[] = []

    for (let callCount = 0; callCount < 5; callCount += 1) {
      const context =
        callCount === 0
          ? userContextInSpace(PROGRESSIVE_SURFACE_REQUEST, space.name, space.slug)
          : toolResultContext(PROGRESSIVE_SURFACE_REQUEST, results)
      const call = toolCallIn(await responder(context, { callCount }))
      calls.push(call)

      const tool = tools.find((candidate) => candidate.name === call.name)
      if (!tool) throw new Error(`missing real tool schema: ${call.name}`)
      expect(tool.schema.safeParse(call.arguments).success).toBe(true)

      results.push({
        toolName: call.name,
        content:
          call.name === 'create_surface'
            ? 'created Surface srf-progressive-returned-by-tool'
            : 'patched tree for Surface srf-progressive-returned-by-tool',
      })
    }

    expect(calls.map((call) => call.name)).toEqual([
      'create_surface',
      'patch_tree',
      'patch_tree',
      'patch_tree',
      'patch_tree',
    ])

    const createCall = calls[0]
    if (!createCall) throw new Error('missing create_surface call')
    expect(createCall.arguments).toMatchObject({
      id: `srf-progressive-${at.getTime()}`,
      title: 'Progressive trip plan',
      state: {},
    })
    const initialTree = AtomNodeSchema.parse(createCall.arguments['tree'])
    expect(
      [
        'progressive-summary',
        'progressive-distance',
        'progressive-chart',
        'progressive-stops',
        'progressive-route',
      ].map((atomId) => {
        const atom = findAtom(initialTree, atomId)
        return [atomId, atom?.type, atom?.props?.['variant']]
      }),
    ).toEqual([
      ['progressive-summary', 'Pending', 'text'],
      ['progressive-distance', 'Pending', 'stat'],
      ['progressive-chart', 'Pending', 'chart'],
      ['progressive-stops', 'Pending', 'list'],
      ['progressive-route', 'Pending', 'image'],
    ])
    expect(findAtom(initialTree, 'progressive-route')?.props?.['timeoutMs']).toBe(8_000)

    expect(calls.slice(1).map((call) => call.arguments)).toMatchObject([
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 1,
        operations: [{ path: '/children/2', value: { id: 'progressive-summary', type: 'Text' } }],
      },
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 2,
        operations: [
          {
            path: '/children/3/children/0/children/0',
            value: { id: 'progressive-distance', type: 'Stat' },
          },
        ],
      },
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 3,
        operations: [
          {
            path: '/children/3/children/1/children/0',
            value: { id: 'progressive-chart', type: 'Chart' },
          },
        ],
      },
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 4,
        operations: [{ path: '/children/4', value: { id: 'progressive-stops', type: 'Col' } }],
      },
    ])

    const closing = await responder(toolResultContext(PROGRESSIVE_SURFACE_REQUEST, results), {
      callCount: 5,
    })
    expect(closing.stopReason).toBe('stop')
    expect(textIn(closing)).toContain('route preview')
    expect(textIn(closing)).toContain('fall back')
  })
})
