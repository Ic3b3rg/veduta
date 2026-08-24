import { SurfaceSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_PARITY_OTHER_SPACE_ID,
  AUTOMATION_PARITY_SPACE_ID,
  AUTOMATION_PARITY_UNTRUSTED_ORIGIN,
  runAutomationParityPair,
} from './provider-automation-parity-fixture.ts'

const EXPECTED_DEFINITIONS = [
  'list_automations',
  'arm_timer',
  'create_job',
  'set_automation_enabled',
  'cancel',
]

const EXPECTED_TOOL_CHAIN = [
  'list_automations',
  'arm_timer',
  'create_job',
  'set_automation_enabled',
  'cancel',
]

describe('AgentRunner Automation parity across Model connection methods (issues #77 and #93)', () => {
  it('offers and executes the same focused-Space Automation contract for BYOK and Codex', async () => {
    const { byok, subscription } = await runAutomationParityPair()

    expect(subscription.outcome).toEqual(byok.outcome)

    const outcome = subscription.outcome
    expect(outcome.offeredDefinitions.map((definition) => definition.name)).toEqual(
      EXPECTED_DEFINITIONS,
    )
    for (const definition of outcome.offeredDefinitions) {
      const schema = recordValue(definition.inputSchema, `${definition.name} schema`)
      const properties = recordValue(schema['properties'], `${definition.name} properties`)
      expect(properties['spaceId'], definition.name).toBeUndefined()
    }
    const enabledStateSchema = recordValue(
      requireDefinition(outcome, 'set_automation_enabled').inputSchema,
      'enabled-state schema',
    )
    expect(
      Object.keys(recordValue(enabledStateSchema['properties'], 'enabled-state properties')).sort(),
    ).toEqual(['automationId', 'enabled'])

    expect(outcome.toolResults.map((result) => result.toolName)).toEqual(EXPECTED_TOOL_CHAIN)
    expect(outcome.handlerExecution).toEqual({
      total: 5,
      distinctCallIds: 5,
      maxCallsPerId: 1,
      allContextHashesValid: true,
      byTool: {
        list_automations: 1,
        arm_timer: 1,
        create_job: 1,
        set_automation_enabled: 1,
        cancel: 1,
      },
    })
    for (const run of [byok, subscription]) {
      expect(run.handlerCallIds).toEqual(run.acceptedCallIds)
      expect(new Set(run.acceptedCallIds).size).toBe(run.acceptedCallIds.length)
    }
    expect(subscription.acceptedCallIds).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5'])
    expect(outcome.toolResults[0]?.content).toContain('Existing focused reminder')
    expect(outcome.toolResults[0]?.content).not.toContain('Other Space reminder')

    expect(outcome.focusedAutomations).toEqual([
      expect.objectContaining({
        spaceId: AUTOMATION_PARITY_SPACE_ID,
        description: 'Existing focused reminder',
        enabled: false,
        status: 'cancelled',
      }),
      expect.objectContaining({
        spaceId: AUTOMATION_PARITY_SPACE_ID,
        kind: 'timer',
        description: 'Check medication',
        status: 'armed',
        origin: AUTOMATION_PARITY_UNTRUSTED_ORIGIN,
      }),
      expect.objectContaining({
        spaceId: AUTOMATION_PARITY_SPACE_ID,
        kind: 'job',
        description: 'Review the plan',
        status: 'armed',
        origin: AUTOMATION_PARITY_UNTRUSTED_ORIGIN,
      }),
    ])
    expect(outcome.otherSpaceAutomations).toEqual([
      expect.objectContaining({
        spaceId: AUTOMATION_PARITY_OTHER_SPACE_ID,
        description: 'Other Space reminder',
        enabled: true,
        status: 'armed',
      }),
    ])

    expect(SurfaceSchema.parse(outcome.automationsSurface)).toEqual(outcome.automationsSurface)
    expect(outcome.automationsSurface.spaceId).toBe(AUTOMATION_PARITY_SPACE_ID)
    expect(Object.values(outcome.automationsSurface.state)).toEqual([true, true])
    expect(outcome.automationsSurface.tree.children?.[1]?.children).toHaveLength(2)

    const automationEvents = outcome.eventLog.filter(isAutomationEvent)
    expect(automationEvents.map((event) => event['type'])).toEqual([
      'automation.arm',
      'automation.arm',
      'automation.toggle',
      'automation.cancel',
    ])
    for (const event of automationEvents) {
      expect(event['origin']).toBe(AUTOMATION_PARITY_UNTRUSTED_ORIGIN)
    }

    expect(subscription.transport.requestMethods).toEqual(['thread/start', 'turn/start'])
    expect(subscription.transport.responseIds).toEqual([0, 1, 2, 3, 4])
    expect(subscription.transport.toolResultTexts).toEqual(byok.toolResultTexts)
  })
})

function requireDefinition(
  outcome: Awaited<ReturnType<typeof runAutomationParityPair>>['byok']['outcome'],
  name: string,
) {
  const definition = outcome.offeredDefinitions.find((candidate) => candidate.name === name)
  if (!definition) throw new Error(`missing provider definition ${name}`)
  return definition
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} is not an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAutomationEvent(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && String(value['type']).startsWith('automation.')
}
