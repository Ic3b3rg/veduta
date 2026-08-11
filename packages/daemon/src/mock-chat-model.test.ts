import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import { createMockChatResponder } from './mock-chat-model.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import type { PiAssistantMessage, PiChatContext } from './pi-provider-bridge.ts'
import { Scheduler } from './scheduler.ts'
import { Store } from './store.ts'
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
