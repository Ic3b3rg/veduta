import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  textIn,
  toolCallIn,
  toolResultContext,
  userContext,
  userContextInSpace,
} from './mock-chat-model.test-helpers.ts'
import { createFocusedAutomationTools } from './focused-automation-tools.ts'
import { createMockChatResponder } from './mock-chat-model.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
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
const CALORIE_REQUEST = 'Quante calorie ho mangiato oggi ?'
const TEMPLATE_SURFACE_REQUEST = 'create Weekly groceries from the Groceries Template'
const CREATE_DAILY_AUTOMATION_REQUEST = 'Create a daily automation to review my plan at 9am'
const LIST_AUTOMATIONS_REQUEST = 'List automations here'
const DISABLE_AUTOMATIONS_REQUEST = 'Disable all automations here'
const CANCEL_AUTOMATIONS_REQUEST = 'Cancel all automations here'

describe('createMockChatResponder', () => {
  it('authors the exact calorie answer into the discovered Meals Surface before replying', async () => {
    const responder = createMockChatResponder({})

    const first = toolCallIn(await responder(userContext(CALORIE_REQUEST), { callCount: 0 }))
    expect(first.name).toBe('list_surfaces')

    const listed = toolResultContext(CALORIE_REQUEST, [
      {
        toolName: 'list_surfaces',
        content: JSON.stringify([{ id: 'meals-live', title: 'Meals' }]),
      },
    ])
    const second = toolCallIn(await responder(listed, { callCount: 1 }))
    expect(second).toMatchObject({ name: 'read_surface', arguments: { surfaceId: 'meals-live' } })

    const read = toolResultContext(CALORIE_REQUEST, [
      {
        toolName: 'list_surfaces',
        content: JSON.stringify([{ id: 'meals-live', title: 'Meals' }]),
      },
      {
        toolName: 'read_surface',
        content: JSON.stringify({
          surface: {
            id: 'meals-live',
            spaceId: 'spc-health',
            title: 'Meals',
            tree: {
              id: 'root',
              type: 'Box',
              children: [{ id: 'title', type: 'Title', props: { text: 'Meals' } }],
            },
            state: {
              mealRecords: [
                {
                  occurredAt: '2026-08-22T06:00:00.000Z',
                  time: '08:00',
                  meal: 'ricotta, cereali e latte',
                },
                { occurredAt: '2026-08-22T11:00:00.000Z', time: '13:00', meal: 'fesa di tacchino' },
              ],
              meals: [],
              lastMeal: 'fesa di tacchino',
              mealCount: 2,
            },
            freshness: { updatedAt: '2026-08-22T11:00:00.000Z', updatedBy: 'user' },
            validity: {
              kind: 'relative-time',
              timeZone: 'Europe/Rome',
              window: 'day',
              startsAt: '2026-08-21T22:00:00.000Z',
              expiresAt: '2026-08-22T22:00:00.000Z',
              source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
              projectionStateKeys: ['meals', 'lastMeal', 'mealCount'],
            },
          },
          version: 3,
          treeVersion: 1,
        }),
      },
    ])
    const statePatch = toolCallIn(await responder(read, { callCount: 2 }))
    expect(statePatch.name).toBe('patch_state')
    expect(statePatch.arguments).toMatchObject({
      surfaceId: 'meals-live',
      operations: expect.arrayContaining([
        expect.objectContaining({ path: '/calorieTotal', value: '≈ 430–650 kcal' }),
        expect.objectContaining({ path: '/calorieBreakdown' }),
        expect.objectContaining({ path: '/calorieCaveat' }),
      ]),
    })

    const patched = toolResultContext(CALORIE_REQUEST, [
      ...read.messages
        .filter((message) => message.role === 'toolResult')
        .map((message) => ({
          toolName: message.toolName,
          content: message.content[0]?.type === 'text' ? message.content[0].text : '',
        })),
      { toolName: 'patch_state', content: 'Surface state patched successfully.' },
    ])
    const treePatch = toolCallIn(await responder(patched, { callCount: 3 }))
    expect(treePatch.name).toBe('patch_tree')
    expect(treePatch.arguments).toMatchObject({ surfaceId: 'meals-live', expectedTreeVersion: 1 })
  })

  it('reports a calorie state failure without attempting a tree mutation', async () => {
    const responder = createMockChatResponder({})
    const context = toolResultContext(CALORIE_REQUEST, [
      {
        toolName: 'list_surfaces',
        content: JSON.stringify([{ id: 'meals-live', title: 'Meals' }]),
      },
      {
        toolName: 'read_surface',
        content: JSON.stringify({
          surface: {
            id: 'meals-live',
            spaceId: 'spc-health',
            title: 'Meals',
            tree: { id: 'root', type: 'Box', children: [] },
            state: {},
            freshness: { updatedAt: '2026-08-22T11:00:00.000Z', updatedBy: 'user' },
          },
          version: 1,
          treeVersion: 1,
        }),
      },
      { toolName: 'patch_state', content: 'conflict', isError: true },
    ])
    const reply = await responder(context, { callCount: 3 })
    expect(reply.stopReason).toBe('stop')
    expect(textIn(reply)).toContain('state update failed')
    expect(reply.content.some((block) => block.type === 'toolCall')).toBe(false)
  })
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

  it('preserves source history and derives every Today value from occurrence time', async () => {
    const store = new Store()
    const responder = createMockChatResponder({
      now: () => new Date('2026-08-03T12:05:00.000Z'),
      timeZone: 'Europe/Rome',
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
              mealRecords: [
                {
                  occurredAt: '2026-08-03T06:10:00.000Z',
                  time: '08:10',
                  meal: 'yogurt',
                },
                {
                  occurredAt: '2026-08-02T18:00:00.000Z',
                  time: '20:00',
                  meal: 'pasta',
                },
                { time: '12:00', meal: 'legacy entry' },
              ],
              meals: [
                {
                  occurredAt: '2026-08-03T06:10:00.000Z',
                  time: '08:10',
                  meal: 'yogurt',
                },
              ],
              lastMeal: 'yogurt',
              mealCount: 1,
            },
            freshness: { updatedAt: '2026-08-03T10:00:00.000Z', updatedBy: 'seed' },
            pinned: false,
            pinnable: true,
            validity: {
              kind: 'relative-time',
              timeZone: 'Europe/Rome',
              window: 'day',
              startsAt: '2026-08-02T22:00:00.000Z',
              expiresAt: '2026-08-03T22:00:00.000Z',
              source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
              projectionStateKeys: ['meals', 'lastMeal', 'mealCount'],
            },
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
          path: '/mealRecords',
          value: [
            {
              occurredAt: '2026-08-03T12:05:00.000Z',
              time: '14:05',
              meal: 'fesa di tacchino',
            },
            {
              occurredAt: '2026-08-03T06:10:00.000Z',
              time: '08:10',
              meal: 'yogurt',
            },
            {
              occurredAt: '2026-08-02T18:00:00.000Z',
              time: '20:00',
              meal: 'pasta',
            },
            { time: '12:00', meal: 'legacy entry' },
          ],
        },
        {
          target: 'state',
          op: 'replace',
          path: '/meals',
          value: [
            {
              occurredAt: '2026-08-03T12:05:00.000Z',
              time: '14:05',
              meal: 'fesa di tacchino',
            },
            {
              occurredAt: '2026-08-03T06:10:00.000Z',
              time: '08:10',
              meal: 'yogurt',
            },
          ],
        },
        {
          target: 'state',
          op: 'replace',
          path: '/lastMeal',
          value: 'fesa di tacchino',
        },
        { target: 'state', op: 'replace', path: '/mealCount', value: 2 },
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
      action: 'log my weight',
      condition: { kind: 'event-logged', textIncludes: 'weight' },
    })
    expect(call.arguments).not.toHaveProperty('spaceId')

    const armTimerSchema = createFocusedAutomationTools({
      scheduler,
      spaceId: 'spc-health',
    }).find((tool) => tool.name === 'arm_timer')!.schema
    const parsed = armTimerSchema.safeParse(call.arguments)
    expect(parsed.success).toBe(true)
  })

  it('does not infer an active Space id from the focused turn system prompt', async () => {
    const responder = createMockChatResponder({
      now: () => new Date('2026-08-03T13:00:00.000Z'),
    })

    const context = userContextInSpace('Remind me to log my weight by 9pm', 'Work', 'work')
    const reply = await responder(context, { callCount: 0 })
    expect(reply.stopReason).toBe('toolUse')

    const call = toolCallIn(reply)
    expect(call.name).toBe('arm_timer')
    expect(call.arguments).not.toHaveProperty('spaceId')
  })

  it('creates a recurring Automation using only focused model-visible inputs', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-mock-chat-automation-'))
    const store = new Store({ rootDir })
    const scheduler = new Scheduler({
      rootDir,
      store,
      now: () => new Date('2026-08-24T09:00:00.000Z'),
    })
    const responder = createMockChatResponder({})

    const reply = await responder(userContext(CREATE_DAILY_AUTOMATION_REQUEST), { callCount: 0 })
    const call = toolCallIn(reply)
    expect(call).toMatchObject({
      name: 'create_job',
      arguments: { cron: '0 9 * * *', briefing: 'Review my plan' },
    })
    expect(call.arguments).not.toHaveProperty('spaceId')

    const schema = createFocusedAutomationTools({ scheduler, spaceId: 'spc-health' }).find(
      (tool) => tool.name === 'create_job',
    )!.schema
    expect(schema.safeParse(call.arguments).success).toBe(true)
    scheduler.stop()
  })

  it('lists Automations from the model-visible inventory', async () => {
    const responder = createMockChatResponder({})
    const first = toolCallIn(
      await responder(userContext(LIST_AUTOMATIONS_REQUEST), { callCount: 0 }),
    )
    expect(first).toMatchObject({ name: 'list_automations', arguments: {} })

    const reply = await responder(
      toolResultContext(LIST_AUTOMATIONS_REQUEST, [
        {
          toolName: 'list_automations',
          content: JSON.stringify([
            {
              id: 7,
              kind: 'job',
              description: 'Review my plan',
              enabled: true,
              status: 'armed',
              cron: '0 9 * * *',
              nextRunAt: '2026-08-25T09:00:00.000Z',
            },
          ]),
        },
      ]),
      { callCount: 1 },
    )
    expect(textIn(reply)).toContain('Review my plan')
    expect(textIn(reply)).toContain('enabled')
  })

  it('disables the complete enabled set discovered through list_automations', async () => {
    const responder = createMockChatResponder({})
    const inventory = JSON.stringify([
      {
        id: 7,
        kind: 'job',
        description: 'Review my plan',
        enabled: true,
        status: 'armed',
      },
      {
        id: 8,
        kind: 'timer',
        description: 'Already off',
        enabled: false,
        status: 'armed',
      },
    ])

    const first = toolCallIn(
      await responder(userContext(DISABLE_AUTOMATIONS_REQUEST), { callCount: 0 }),
    )
    expect(first).toMatchObject({ name: 'list_automations', arguments: {} })

    const second = toolCallIn(
      await responder(
        toolResultContext(DISABLE_AUTOMATIONS_REQUEST, [
          { toolName: 'list_automations', content: inventory },
        ]),
        { callCount: 1 },
      ),
    )
    expect(second).toMatchObject({
      name: 'set_automation_enabled',
      arguments: { automationId: 7, enabled: false },
    })
    expect(second.arguments).not.toHaveProperty('spaceId')

    const completed = await responder(
      toolResultContext(DISABLE_AUTOMATIONS_REQUEST, [
        { toolName: 'list_automations', content: inventory },
        { toolName: 'set_automation_enabled', content: 'automation 7 is disabled' },
      ]),
      { callCount: 2 },
    )
    expect(textIn(completed)).toBe('Disabled 1 Automation in this Space.')
  })

  it('cancels the complete affected set discovered through list_automations', async () => {
    const responder = createMockChatResponder({})
    const inventory = JSON.stringify([
      {
        id: 7,
        kind: 'job',
        description: 'Review my plan',
        enabled: false,
        status: 'armed',
      },
      {
        id: 8,
        kind: 'timer',
        description: 'Second reminder',
        enabled: true,
        status: 'armed',
      },
    ])

    const first = toolCallIn(
      await responder(userContext(CANCEL_AUTOMATIONS_REQUEST), { callCount: 0 }),
    )
    expect(first).toMatchObject({ name: 'list_automations', arguments: {} })

    const second = toolCallIn(
      await responder(
        toolResultContext(CANCEL_AUTOMATIONS_REQUEST, [
          { toolName: 'list_automations', content: inventory },
        ]),
        { callCount: 1 },
      ),
    )
    expect(second).toMatchObject({ name: 'cancel', arguments: { automationId: 7 } })
    expect(second.arguments).not.toHaveProperty('spaceId')

    const third = toolCallIn(
      await responder(
        toolResultContext(CANCEL_AUTOMATIONS_REQUEST, [
          { toolName: 'list_automations', content: inventory },
          { toolName: 'cancel', content: 'cancelled automation 7' },
        ]),
        { callCount: 2 },
      ),
    )
    expect(third).toMatchObject({ name: 'cancel', arguments: { automationId: 8 } })

    const completed = await responder(
      toolResultContext(CANCEL_AUTOMATIONS_REQUEST, [
        { toolName: 'list_automations', content: inventory },
        { toolName: 'cancel', content: 'cancelled automation 7' },
        { toolName: 'cancel', content: 'cancelled automation 8' },
      ]),
      { callCount: 3 },
    )
    expect(textIn(completed)).toBe('Cancelled 2 Automations in this Space.')
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
