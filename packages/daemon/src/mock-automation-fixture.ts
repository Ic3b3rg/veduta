import {
  piFauxAssistantMessage,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'

const CREATE_DAILY_AUTOMATION_REQUEST = 'Create a daily automation to review my plan at 9am'
const LIST_AUTOMATIONS_REQUEST = 'List automations here'
const DISABLE_AUTOMATIONS_REQUEST = 'Disable all automations here'
const CANCEL_AUTOMATIONS_REQUEST = 'Cancel all automations here'

type PiTurnMessage = PiChatContext['messages'][number]
type PiToolResultMessage = Extract<PiTurnMessage, { role: 'toolResult' }>

interface AutomationSummary {
  id: number
  kind: 'timer' | 'job'
  description: string
  enabled: boolean
  status: 'armed' | 'completed'
}

type BulkMutation = 'disable' | 'cancel'

interface BulkMutationDescriptor {
  completionVerb: string
  failurePrefix: string
  listMessage: string
  progressMessage: (automation: AutomationSummary) => string
  targets: (inventory: AutomationSummary[]) => AutomationSummary[]
  toolArguments: (automation: AutomationSummary) => Record<string, unknown>
  toolName: 'set_automation_enabled' | 'cancel'
}

const BULK_MUTATIONS: Record<BulkMutation, BulkMutationDescriptor> = {
  disable: {
    completionVerb: 'Disabled',
    failurePrefix: 'The enabled state was not fully changed',
    listMessage: 'Finding the complete enabled Automation set in this Space.',
    progressMessage: (automation) => `Disabling “${automation.description}”.`,
    targets: (inventory) => inventory.filter((automation) => automation.enabled),
    toolArguments: (automation) => ({ automationId: automation.id, enabled: false }),
    toolName: 'set_automation_enabled',
  },
  cancel: {
    completionVerb: 'Cancelled',
    failurePrefix: 'The Automations were not fully cancelled',
    listMessage: 'Finding the complete Automation set in this Space.',
    progressMessage: (automation) => `Cancelling “${automation.description}”.`,
    targets: (inventory) => inventory,
    toolArguments: (automation) => ({ automationId: automation.id }),
    toolName: 'cancel',
  },
}

/** Deterministic issue #93 journey for Loopback-profile browser and integration tests. */
export function respondToMockAutomation(
  text: string,
  results: PiToolResultMessage[],
): PiAssistantMessage | undefined {
  if (text === CREATE_DAILY_AUTOMATION_REQUEST) {
    if (results.some((result) => result.toolName === 'create_job')) return undefined
    return toolCallMessage(
      'create_job',
      { cron: '0 9 * * *', briefing: 'Review my plan' },
      'Creating a daily Automation to review your plan at 09:00 UTC.',
    )
  }
  if (text === LIST_AUTOMATIONS_REQUEST) return respondToInventory(results)
  if (text === DISABLE_AUTOMATIONS_REQUEST) return respondToBulkMutation(results, 'disable')
  if (text === CANCEL_AUTOMATIONS_REQUEST) return respondToBulkMutation(results, 'cancel')
  return undefined
}

function respondToInventory(results: PiToolResultMessage[]): PiAssistantMessage {
  const listResult = results.find((result) => result.toolName === 'list_automations')
  if (!listResult) {
    return toolCallMessage('list_automations', {}, 'Reading every Automation in this Space.')
  }
  const automations = automationSummaries(toolResultText(listResult))
  if (!automations) return piFauxAssistantMessage('The Automation inventory could not be read.')
  if (automations.length === 0) return piFauxAssistantMessage('This Space has no Automations.')
  return piFauxAssistantMessage(
    automations
      .map(
        (automation) =>
          `${automation.id}: ${automation.description} — ${automation.enabled ? 'enabled' : 'disabled'} (${automation.kind}, ${automation.status})`,
      )
      .join('\n'),
  )
}

function respondToBulkMutation(
  results: PiToolResultMessage[],
  mutation: BulkMutation,
): PiAssistantMessage {
  const descriptor = BULK_MUTATIONS[mutation]
  const listResult = results.find((result) => result.toolName === 'list_automations')
  if (!listResult) {
    return toolCallMessage('list_automations', {}, descriptor.listMessage)
  }

  const inventory = automationSummaries(toolResultText(listResult))
  if (!inventory) return piFauxAssistantMessage('The Automation inventory could not be read.')
  const targets = descriptor.targets(inventory)
  const mutations = results.filter((result) => result.toolName === descriptor.toolName)
  const failed = mutations.find((result) => result.isError)
  if (failed) {
    return piFauxAssistantMessage(`${descriptor.failurePrefix}: ${toolResultText(failed)}`)
  }

  const next = targets[mutations.length]
  if (next) {
    return toolCallMessage(
      descriptor.toolName,
      descriptor.toolArguments(next),
      descriptor.progressMessage(next),
    )
  }

  return piFauxAssistantMessage(
    `${descriptor.completionVerb} ${targets.length} ${targets.length === 1 ? 'Automation' : 'Automations'} in this Space.`,
  )
}

function automationSummaries(content: string): AutomationSummary[] | undefined {
  const parsed = parseJson(content)
  if (!Array.isArray(parsed)) return undefined
  const summaries: AutomationSummary[] = []
  for (const candidate of parsed) {
    if (!isRecord(candidate)) return undefined
    const { id, kind, description, enabled, status } = candidate
    if (
      typeof id !== 'number' ||
      (kind !== 'timer' && kind !== 'job') ||
      typeof description !== 'string' ||
      typeof enabled !== 'boolean' ||
      (status !== 'armed' && status !== 'completed')
    ) {
      return undefined
    }
    summaries.push({ id, kind, description, enabled, status })
  }
  return summaries
}
