import { describe, expect, it } from 'vitest'
import { textIn, toolCallIn, toolResultContext } from './mock-chat-model.test-helpers.ts'
import { respondToMockAutomation } from './mock-automation-fixture.ts'
import type { PiChatContext } from './pi-provider-bridge.ts'

const CREATE_REQUEST = 'Create a daily automation to review my plan at 9am'
const LIST_REQUEST = 'List automations here'
const DISABLE_REQUEST = 'Disable all automations here'
const CANCEL_REQUEST = 'Cancel all automations here'

type PiTurnMessage = PiChatContext['messages'][number]
type PiToolResultMessage = Extract<PiTurnMessage, { role: 'toolResult' }>

describe('respondToMockAutomation', () => {
  it('ignores unrelated Loopback requests', () => {
    expect(respondToMockAutomation('hello', [])).toBeUndefined()
  })

  it('creates a recurring Automation using only focused model-visible inputs', () => {
    const reply = requireResponse(respondToMockAutomation(CREATE_REQUEST, []))
    const call = toolCallIn(reply)

    expect(call).toMatchObject({
      name: 'create_job',
      arguments: { cron: '0 9 * * *', briefing: 'Review my plan' },
    })
    expect(call.arguments).not.toHaveProperty('spaceId')
    expect(
      respondToMockAutomation(
        CREATE_REQUEST,
        results(CREATE_REQUEST, [{ toolName: 'create_job', content: 'created job 7' }]),
      ),
    ).toBeUndefined()
  })

  it('lists Automations from the model-visible inventory', () => {
    const first = toolCallIn(requireResponse(respondToMockAutomation(LIST_REQUEST, [])))
    expect(first).toMatchObject({ name: 'list_automations', arguments: {} })

    const reply = requireResponse(
      respondToMockAutomation(
        LIST_REQUEST,
        results(LIST_REQUEST, [
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
      ),
    )
    expect(textIn(reply)).toContain('Review my plan')
    expect(textIn(reply)).toContain('enabled')
  })

  it('disables the complete enabled set discovered through list_automations', () => {
    const inventory = automationInventory([
      { id: 7, kind: 'job', description: 'Review my plan', enabled: true, status: 'armed' },
      { id: 8, kind: 'timer', description: 'Already off', enabled: false, status: 'armed' },
    ])

    const first = toolCallIn(requireResponse(respondToMockAutomation(DISABLE_REQUEST, [])))
    expect(first).toMatchObject({ name: 'list_automations', arguments: {} })

    const second = toolCallIn(
      requireResponse(
        respondToMockAutomation(
          DISABLE_REQUEST,
          results(DISABLE_REQUEST, [{ toolName: 'list_automations', content: inventory }]),
        ),
      ),
    )
    expect(second).toMatchObject({
      name: 'set_automation_enabled',
      arguments: { automationId: 7, enabled: false },
    })
    expect(second.arguments).not.toHaveProperty('spaceId')

    const completed = requireResponse(
      respondToMockAutomation(
        DISABLE_REQUEST,
        results(DISABLE_REQUEST, [
          { toolName: 'list_automations', content: inventory },
          { toolName: 'set_automation_enabled', content: 'automation 7 is disabled' },
        ]),
      ),
    )
    expect(textIn(completed)).toBe('Disabled 1 Automation in this Space.')
  })

  it('cancels the complete affected set discovered through list_automations', () => {
    const inventory = automationInventory([
      { id: 7, kind: 'job', description: 'Review my plan', enabled: false, status: 'armed' },
      { id: 8, kind: 'timer', description: 'Second reminder', enabled: true, status: 'armed' },
    ])

    const first = toolCallIn(requireResponse(respondToMockAutomation(CANCEL_REQUEST, [])))
    expect(first).toMatchObject({ name: 'list_automations', arguments: {} })

    const second = toolCallIn(
      requireResponse(
        respondToMockAutomation(
          CANCEL_REQUEST,
          results(CANCEL_REQUEST, [{ toolName: 'list_automations', content: inventory }]),
        ),
      ),
    )
    expect(second).toMatchObject({ name: 'cancel', arguments: { automationId: 7 } })
    expect(second.arguments).not.toHaveProperty('spaceId')

    const third = toolCallIn(
      requireResponse(
        respondToMockAutomation(
          CANCEL_REQUEST,
          results(CANCEL_REQUEST, [
            { toolName: 'list_automations', content: inventory },
            { toolName: 'cancel', content: 'cancelled automation 7' },
          ]),
        ),
      ),
    )
    expect(third).toMatchObject({ name: 'cancel', arguments: { automationId: 8 } })

    const completed = requireResponse(
      respondToMockAutomation(
        CANCEL_REQUEST,
        results(CANCEL_REQUEST, [
          { toolName: 'list_automations', content: inventory },
          { toolName: 'cancel', content: 'cancelled automation 7' },
          { toolName: 'cancel', content: 'cancelled automation 8' },
        ]),
      ),
    )
    expect(textIn(completed)).toBe('Cancelled 2 Automations in this Space.')
  })

  it('stops a bulk mutation after the first failed tool result', () => {
    const inventory = automationInventory([
      { id: 7, kind: 'job', description: 'First', enabled: true, status: 'armed' },
      { id: 8, kind: 'job', description: 'Second', enabled: true, status: 'armed' },
    ])
    const response = requireResponse(
      respondToMockAutomation(
        DISABLE_REQUEST,
        results(DISABLE_REQUEST, [
          { toolName: 'list_automations', content: inventory },
          {
            toolName: 'set_automation_enabled',
            content: 'Automation is unavailable in this Space',
            isError: true,
          },
        ]),
      ),
    )

    expect(response.stopReason).not.toBe('toolUse')
    expect(textIn(response)).toContain('Automation is unavailable in this Space')
  })
})

function results(
  request: string,
  toolResults: Array<{ toolName: string; content: string; isError?: boolean }>,
): PiToolResultMessage[] {
  return toolResultContext(request, toolResults).messages.filter(
    (message): message is PiToolResultMessage => message.role === 'toolResult',
  )
}

function automationInventory(
  automations: Array<{
    id: number
    kind: 'timer' | 'job'
    description: string
    enabled: boolean
    status: 'armed' | 'completed'
  }>,
): string {
  return JSON.stringify(automations)
}

function requireResponse(response: ReturnType<typeof respondToMockAutomation>) {
  if (!response) throw new Error('expected a mock Automation response')
  return response
}
