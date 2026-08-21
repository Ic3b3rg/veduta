import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { AtomNodeSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import type { PiAssistantMessage, PiChatContext } from './pi-provider-bridge.ts'
import { Scheduler } from './scheduler.ts'
import { Store } from './store.ts'
import { TemplateEngine, templateTools } from './template-engine.ts'
import { WorkerBriefingSchema } from './worker-briefing.ts'

/**
 * Drives `createMockChatResponder` as a pure function against hand-built pi
 * turn contexts (`fromPartial`, same idiom `scheduler.test.ts`/
 * `outbound-tools.test.ts` use for `ToolContext` fixtures) — no live
 * `PiAgentRunner`/provider needed, since the responder only ever reads
 * `context.messages`. Surface state appears only in model-visible tool
 * results; the responder has no Store reference.
 */

const MEAL_REQUEST = 'aggiungi ai meals la fesa di tacchino'
const TEMPLATE_SURFACE_REQUEST = 'create Weekly groceries from the Groceries Template'
const PROGRESSIVE_SURFACE_REQUEST = 'show progressive surface demo'

function userContext(text: string): PiChatContext {
  return fromPartial<PiChatContext>({
    messages: [{ role: 'user', content: text, timestamp: Date.now() }],
  })
}

/** Mirrors `spaces-engine.ts`'s `assembleContext` Active Space section shape (`section('Active Space', ...)`), just enough for `activeSpaceId` to parse `slug` back out. */
function userContextInSpace(text: string, name: string, slug: string): PiChatContext {
  return fromPartial<PiChatContext>({
    systemPrompt: `# Active Space\n\n${name} (${slug})\nSome granularity rule.\nSome timer rule.`,
    messages: [{ role: 'user', content: text, timestamp: Date.now() }],
  })
}

function toolResultContext(
  userText: string,
  results: Array<{ toolName: string; content: string }>,
): PiChatContext {
  return fromPartial<PiChatContext>({
    messages: [
      { role: 'user', content: userText, timestamp: Date.now() },
      ...results.flatMap((result, index) => {
        const toolCallId = `call-${index + 1}`
        return [
          {
            role: 'assistant' as const,
            content: [
              {
                type: 'toolCall' as const,
                id: toolCallId,
                name: result.toolName,
                arguments: {},
              },
            ],
            stopReason: 'toolUse' as const,
          },
          {
            role: 'toolResult' as const,
            toolCallId,
            toolName: result.toolName,
            content: [{ type: 'text' as const, text: result.content }],
            isError: false,
            timestamp: Date.now(),
          },
        ]
      }),
    ],
  })
}

function toolCallIn(message: PiAssistantMessage) {
  const call = message.content.find((block) => block.type === 'toolCall')
  if (!call || call.type !== 'toolCall') throw new Error('expected a tool call in the message')
  return call
}

function textIn(message: PiAssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n')
}

describe('createMockChatResponder', () => {
  it('closes with a stable summary after a tool result (the follow-up model call)', async () => {
    const responder = createMockChatResponder({})
    const context = toolResultContext('send to alice@example.com: hello', [
      { toolName: 'send_message', content: 'ok' },
    ])
    const reply = await responder(context, { callCount: 1 })
    expect(reply.stopReason).toBe('stop')
    expect(textIn(reply)).toBe('Done — send_message completed.')
  })

  it('starts the Italian meal fixture by discovering authorable Surfaces', async () => {
    const responder = createMockChatResponder({})
    const reply = await responder(userContext(MEAL_REQUEST), { callCount: 0 })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('list_surfaces')
    expect(call.arguments).toEqual({})
  })

  it('reads the Meals id returned by list_surfaces instead of using a fixed id', async () => {
    const responder = createMockChatResponder({})
    const context = toolResultContext(MEAL_REQUEST, [
      {
        toolName: 'list_surfaces',
        content: JSON.stringify([
          {
            id: 'surface-discovered-from-tool',
            title: 'Meals',
            freshness: { updatedAt: '2026-08-03T10:00:00.000Z', updatedBy: 'seed' },
            pinned: false,
          },
        ]),
      },
    ])

    const call = toolCallIn(await responder(context, { callCount: 1 }))
    expect(call.name).toBe('read_surface')
    expect(call.arguments).toEqual({ surfaceId: 'surface-discovered-from-tool' })
  })

  it('derives a valid patch from read_surface state and preserves numeric state values', async () => {
    const store = new Store()
    const responder = createMockChatResponder({
      now: () => new Date(2026, 7, 3, 14, 5),
    })
    const context = toolResultContext(MEAL_REQUEST, [
      {
        toolName: 'list_surfaces',
        content: JSON.stringify([
          {
            id: 'surface-discovered-from-tool',
            title: 'Meals',
            freshness: { updatedAt: '2026-08-03T10:00:00.000Z', updatedBy: 'seed' },
            pinned: false,
          },
        ]),
      },
      {
        toolName: 'read_surface',
        content: JSON.stringify({
          surface: {
            id: 'surface-discovered-from-tool',
            spaceId: 'spc-health',
            title: 'Meals',
            tree: { id: 'root', type: 'Box', children: [] },
            state: {
              meals: [{ time: '08:10', meal: 'yogurt' }],
              lastMeal: 'yogurt',
              mealCount: 7,
            },
            freshness: { updatedAt: '2026-08-03T10:00:00.000Z', updatedBy: 'seed' },
            pinned: false,
            pinnable: true,
          },
          version: 11,
          treeVersion: 4,
        }),
      },
    ])

    const reply = await responder(context, { callCount: 2 })
    const call = toolCallIn(reply)
    expect(call.name).toBe('patch_state')
    expect(call.arguments).toEqual({
      surfaceId: 'surface-discovered-from-tool',
      operations: [
        {
          target: 'state',
          op: 'replace',
          path: '/meals',
          value: [
            { time: '14:05', meal: 'fesa di tacchino' },
            { time: '08:10', meal: 'yogurt' },
          ],
        },
        {
          target: 'state',
          op: 'replace',
          path: '/lastMeal',
          value: 'fesa di tacchino',
        },
        { target: 'state', op: 'replace', path: '/mealCount', value: 8 },
      ],
    })

    const patchStateSchema = store
      .surfaceTools()
      .find((tool) => tool.name === 'patch_state')!.schema
    expect(patchStateSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('reports that no Meals Surface was found when the visible inventory has none', async () => {
    const responder = createMockChatResponder({})
    const reply = await responder(
      toolResultContext(MEAL_REQUEST, [{ toolName: 'list_surfaces', content: '[]' }]),
      { callCount: 1 },
    )
    expect(reply.stopReason).toBe('stop')
    expect(textIn(reply)).toContain('Meals Surface')
  })

  it('starts the Local VPS Template fixture by finding the Groceries Template', async () => {
    const responder = createMockChatResponder({})
    const reply = await responder(userContext(TEMPLATE_SURFACE_REQUEST), { callCount: 0 })

    expect(reply.stopReason).toBe('toolUse')
    const call = toolCallIn(reply)
    expect(call.name).toBe('list_templates')
    expect(call.arguments).toEqual({ intent: 'Groceries' })
  })

  it('instantiates the Template identity returned by list_templates through the real tool schema', async () => {
    const store = new Store()
    const space = store.spacesEngine.createSpace({ name: 'Health' })
    const engine = new TemplateEngine({ store })
    const responder = createMockChatResponder({})
    const context = toolResultContext(TEMPLATE_SURFACE_REQUEST, [
      {
        toolName: 'list_templates',
        content:
          'tpl-groceries-0123456789abcdef (Space spc-health) score=1.20 — "Groceries" ' +
          'intent="Groceries" signature="Box:1|Checkbox:1" dataProps=[]',
      },
    ])

    const reply = await responder(context, { callCount: 1 })
    expect(reply.stopReason).toBe('toolUse')
    const call = toolCallIn(reply)
    expect(call.name).toBe('create_surface_from_template')
    expect(call.arguments).toEqual({
      templateId: 'tpl-groceries-0123456789abcdef',
      templateSpaceId: 'spc-health',
      surfaceId: 'srf-weekly-groceries',
      title: 'Weekly groceries',
    })

    const createFromTemplateSchema = templateTools(engine, { activeSpaceId: space.id }).find(
      (tool) => tool.name === 'create_surface_from_template',
    )!.schema
    expect(createFromTemplateSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('scripts a protocol-valid layout-first Surface and fills four regions with independent tree patches', async () => {
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
    const calls = []

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
    expect(initialTree.children?.[2]).toMatchObject({
      id: 'progressive-summary',
      type: 'Pending',
      props: { variant: 'text', lines: 3 },
    })
    expect(initialTree.children?.[3]?.children?.[0]?.children?.[0]).toMatchObject({
      id: 'progressive-distance',
      type: 'Pending',
      props: { variant: 'stat' },
    })
    expect(initialTree.children?.[3]?.children?.[1]?.children?.[0]).toMatchObject({
      id: 'progressive-chart',
      type: 'Pending',
      props: { variant: 'chart' },
    })
    expect(initialTree.children?.[4]).toMatchObject({
      id: 'progressive-stops',
      type: 'Pending',
      props: { variant: 'list' },
    })
    expect(initialTree.children?.[5]).toMatchObject({
      id: 'progressive-route',
      type: 'Pending',
      props: { variant: 'image', timeoutMs: 8_000 },
    })

    expect(calls.slice(1).map((call) => call.arguments)).toEqual([
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 1,
        operations: [
          {
            target: 'tree',
            op: 'replace',
            path: '/children/2',
            value: {
              id: 'progressive-summary',
              type: 'Text',
              props: {
                text: 'A four-day coastal route with short drives and time for unplanned stops.',
              },
            },
          },
        ],
      },
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 2,
        operations: [
          {
            target: 'tree',
            op: 'replace',
            path: '/children/3/children/0/children/0',
            value: {
              id: 'progressive-distance',
              type: 'Stat',
              props: { label: 'Total distance', value: '286 km', detail: 'About 72 km per day' },
            },
          },
        ],
      },
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 3,
        operations: [
          {
            target: 'tree',
            op: 'replace',
            path: '/children/3/children/1/children/0',
            value: {
              id: 'progressive-chart',
              type: 'Chart',
              props: {
                label: 'Distance by day',
                data: [
                  { label: 'Day 1', value: 54 },
                  { label: 'Day 2', value: 81 },
                  { label: 'Day 3', value: 63 },
                  { label: 'Day 4', value: 88 },
                ],
              },
            },
          },
        ],
      },
      {
        surfaceId: 'srf-progressive-returned-by-tool',
        expectedTreeVersion: 4,
        operations: [
          {
            target: 'tree',
            op: 'replace',
            path: '/children/4',
            value: {
              id: 'progressive-stops',
              type: 'Col',
              children: [
                {
                  id: 'progressive-stop-camogli',
                  type: 'ListItem',
                  props: { label: 'Camogli', detail: 'Morning harbor walk', status: 'Day 1' },
                },
                {
                  id: 'progressive-stop-lerici',
                  type: 'ListItem',
                  props: { label: 'Lerici', detail: 'Late lunch by the castle', status: 'Day 3' },
                },
              ],
            },
          },
        ],
      },
    ])

    const closing = await responder(toolResultContext(PROGRESSIVE_SURFACE_REQUEST, results), {
      callCount: 5,
    })
    expect(closing.stopReason).toBe('stop')
    expect(textIn(closing)).toContain('route preview')
    expect(textIn(closing)).toContain('fallback')
  })

  it('arms a reminder via arm_timer, validating against the real Scheduler schema', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-mock-chat-model-'))
    const store = new Store({ rootDir })
    const scheduler = new Scheduler({
      rootDir,
      store,
      now: () => new Date('2026-08-03T13:00:00.000Z'),
    })
    const responder = createMockChatResponder({
      now: () => new Date('2026-08-03T13:00:00.000Z'),
    })

    const reply = await responder(userContext('Remind me to log my weight by 9pm'), {
      callCount: 0,
    })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('arm_timer')
    expect(call.arguments).toMatchObject({
      spaceId: 'spc-health',
      action: 'log my weight',
      condition: { kind: 'event-logged', textIncludes: 'weight' },
    })

    const armTimerSchema = scheduler.tools().find((tool) => tool.name === 'arm_timer')!.schema
    const parsed = armTimerSchema.safeParse(call.arguments)
    expect(parsed.success).toBe(true)
  })

  it('arms a reminder with the active Space id parsed off the systemPrompt, not the spc-health fallback', async () => {
    const responder = createMockChatResponder({
      now: () => new Date('2026-08-03T13:00:00.000Z'),
    })

    const context = userContextInSpace('Remind me to log my weight by 9pm', 'Work', 'work')
    const reply = await responder(context, { callCount: 0 })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('arm_timer')
    expect(call.arguments).toMatchObject({ spaceId: 'spc-work' })
  })

  it('dispatches send_message, validating against the real outbound-tools schema', async () => {
    const store = new Store()
    const transport = createMockOutboundTransport(store.spacesEngine)
    const responder = createMockChatResponder({})

    const reply = await responder(userContext('send to alice@example.com: pick up milk'), {
      callCount: 0,
    })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('send_message')
    expect(call.arguments).toEqual({ to: 'alice@example.com', body: 'pick up milk' })

    const sendMessageSchema = createOutboundTools(transport).find(
      (registration) => registration.tool.name === 'send_message',
    )!.tool.schema
    expect(sendMessageSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('dispatches transfer_funds, validating against the real outbound-tools schema', async () => {
    const store = new Store()
    const transport = createMockOutboundTransport(store.spacesEngine)
    const responder = createMockChatResponder({})

    const reply = await responder(userContext('transfer 42.50 to bob'), { callCount: 0 })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('transfer_funds')
    expect(call.arguments).toEqual({ to: 'bob', amount: 42.5 })

    const transferFundsSchema = createOutboundTools(transport).find(
      (registration) => registration.tool.name === 'transfer_funds',
    )!.tool.schema
    expect(transferFundsSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('spawns a Worker for research <topic>, validating against WorkerBriefingSchema', async () => {
    const responder = createMockChatResponder({})

    const reply = await responder(userContext('research the best coffee grinders'), {
      callCount: 0,
    })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('spawn_worker')
    expect(call.arguments).toMatchObject({
      goal: 'the best coffee grinders',
      tokenBudget: 100_000,
      maxIterations: 6,
      tier: 'reasoning',
      highRisk: true,
    })
    expect(WorkerBriefingSchema.safeParse(call.arguments).success).toBe(true)
  })

  it('answers help/aiuto with a text-only reply', async () => {
    const responder = createMockChatResponder({})
    const reply = await responder(userContext('can you help me?'), { callCount: 0 })
    expect(reply.stopReason).toBe('stop')
    expect(reply.content.some((block) => block.type === 'toolCall')).toBe(false)
    expect(textIn(reply)).toContain('mock provider')
  })

  it('defaults to a deterministic echo for anything else', async () => {
    const responder = createMockChatResponder({})
    const reply = await responder(userContext('what is next?'), { callCount: 0 })
    expect(reply.stopReason).toBe('stop')
    expect(textIn(reply)).toBe('[mock] You said: "what is next?".')
  })
})
