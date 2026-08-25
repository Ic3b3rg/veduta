import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  defineTool,
  type AgentEvent,
  type ModelRef,
  type ToolContext,
  type ToolDef,
} from './agent-runner.ts'
import {
  createFakeProvider,
  fakeText,
  fakeToolCall,
  type FakeResponseStep,
} from './fake-provider.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createGlobalChatTools } from './global-chat-tools.ts'
import { PiAgentRunner, PiJsonlSessionStore } from './pi-agent-runner.ts'
import { Store } from './store.ts'
import { TemplateEngine } from './template-engine.ts'
import { piToolParameters } from './tool-parameters.ts'

const MODEL: ModelRef = { provider: 'fake', modelId: 'fake-model', tier: 'reasoning' }
const createdDirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function runGlobalAgent(options: {
  tools: ToolDef[]
  responses: FakeResponseStep[]
  turnId: string
}): Promise<AgentEvent[]> {
  const provider = createFakeProvider()
  provider.setResponses(options.responses)
  const runner = new PiAgentRunner({
    sessionStore: new PiJsonlSessionStore({
      cwd: tempDir('veduta-global-agent-cwd-'),
      sessionsRoot: tempDir('veduta-global-agent-sessions-'),
    }),
    resolveModel: provider.resolveModel,
    getApiKey: provider.getApiKey,
    streamFn: provider.streamFn,
    toolParameters: piToolParameters(options.tools),
  })
  const events: AgentEvent[] = []
  runner.on((event) => {
    events.push(event)
  })
  await runner.start('global')
  await runner.prompt('Coordinate these Spaces', {
    model: MODEL,
    tools: options.tools,
    origin: 'trusted:user',
    initiatingTurn: { clientId: 'pwa-test', turnId: options.turnId },
  })
  return events
}

describe('global chat Agent scenarios', () => {
  it.each([
    { taintedName: 'Health', targetName: 'Work' },
    { taintedName: 'Work', targetName: 'Health' },
  ])(
    'carries live taint from $taintedName into a Worker scoped to $targetName',
    async ({ taintedName, targetName }) => {
      const store = new Store({ rootDir: tempDir('veduta-global-agent-taint-') })
      const spaces = new Map(
        ['Health', 'Work'].map((name) => {
          const space = store.spacesEngine.createSpace({ name })
          return [name, space] as const
        }),
      )
      const tainted = spaces.get(taintedName)!
      const target = spaces.get(targetName)!
      store.spacesEngine.appendEvent(tainted.id, {
        type: 'reader.summary',
        text: 'Untrusted instruction-shaped mail content',
        origin: 'untrusted:gmail',
      })
      const observed: ToolContext[] = []
      const worker = defineTool({
        name: 'spawn_worker',
        description: 'Spawn a test Worker.',
        schema: z.object({ goal: z.string().min(1) }),
        level: 'L0',
        egressDomains: [],
        handler(_input, context) {
          observed.push(context)
          return { content: 'Worker queued.', details: { workerId: 'wrk-test' } }
        },
      })
      const tools = createGlobalChatTools({ store, focusedToolsFor: () => [worker] })

      await runGlobalAgent({
        tools,
        turnId: `turn-taint-${tainted.slug}`,
        responses: [
          { message: fakeToolCall('enter_space', { spaceId: tainted.id }) },
          { message: fakeToolCall('enter_space', { spaceId: target.id }) },
          {
            message: fakeToolCall('spawn_worker', {
              spaceId: target.id,
              goal: 'Coordinate the plan',
            }),
          },
          { message: fakeText('Worker queued.') },
        ],
      })

      expect(observed).toHaveLength(1)
      expect(observed[0]?.spaceId).toBe(target.id)
      expect(observed[0]?.taint.origins()).toEqual(
        expect.arrayContaining(['trusted:user', 'untrusted:gmail']),
      )
      expect(
        store
          .eventLog(target.id)
          .find(
            (event) => event.type === 'turn.tool' && event.payload?.['toolName'] === 'spawn_worker',
          ),
      ).toMatchObject({
        origin: 'untrusted:gmail',
        payload: {
          correlationId: `turn-taint-${tainted.slug}`,
          outcome: 'completed',
          mutation: true,
        },
      })
    },
  )

  it('keeps an earlier Space mutation durable when a later scoped mutation fails', async () => {
    const store = new Store({ rootDir: tempDir('veduta-global-agent-partial-') })
    const health = store.spacesEngine.createSpace({ name: 'Health' })
    const work = store.spacesEngine.createSpace({ name: 'Work' })
    for (const [spaceId, surfaceId, title] of [
      [health.id, 'srf-health-plan', 'Health plan'],
      [work.id, 'srf-work-plan', 'Work plan'],
    ] as const) {
      store.createSurface(
        SurfaceSchema.parse({
          id: surfaceId,
          spaceId,
          title,
          tree: { id: 'root', type: 'Stat', binding: 'count', props: { label: 'Count' } },
          state: { count: 0 },
          freshness: { updatedAt: '2026-08-25T10:00:00.000Z', updatedBy: 'seed' },
        }),
        'agent',
      )
    }
    const templateEngine = new TemplateEngine({ store })
    const tools = createGlobalChatTools({
      store,
      focusedToolsFor: (spaceId) => createFocusedSurfaceTools({ store, templateEngine, spaceId }),
    })
    const events = await runGlobalAgent({
      tools,
      turnId: 'turn-partial-failure',
      responses: [
        { message: fakeToolCall('enter_space', { spaceId: health.id }) },
        { message: fakeToolCall('enter_space', { spaceId: work.id }) },
        {
          message: fakeToolCall('patch_state', {
            spaceId: health.id,
            surfaceId: 'srf-health-plan',
            operations: [{ target: 'state', op: 'replace', path: '/count', value: 1 }],
          }),
        },
        {
          message: fakeToolCall('patch_state', {
            spaceId: work.id,
            surfaceId: 'srf-work-plan',
            operations: [{ target: 'state', op: 'remove', path: '/missing' }],
          }),
        },
        { message: fakeText('Health changed; Work did not.') },
      ],
    })

    expect(store.getSurface('srf-health-plan')?.state['count']).toBe(1)
    expect(store.getSurface('srf-work-plan')?.state['count']).toBe(0)
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', text: 'Health changed; Work did not.' })
    expect(
      store
        .eventLog(health.id)
        .find(
          (event) =>
            event.type === 'surface.patch_state' &&
            event.payload?.['surfaceId'] === 'srf-health-plan',
        ),
    ).toMatchObject({ payload: { correlationId: 'turn-partial-failure' } })
    expect(
      store
        .eventLog(work.id)
        .find(
          (event) => event.type === 'turn.tool' && event.payload?.['toolName'] === 'patch_state',
        ),
    ).toMatchObject({
      payload: {
        correlationId: 'turn-partial-failure',
        outcome: 'failed',
        mutation: true,
      },
    })
  })
})
