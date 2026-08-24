import {
  SurfaceSchema,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type Surface,
} from '@veduta/protocol'
import {
  piFauxAssistantMessage,
  type MockResponder,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'
import {
  DEFAULT_PROGRESSIVE_FILL_DELAY_MS,
  PROGRESSIVE_SURFACE_REQUEST,
  progressiveFillSteps,
  progressiveSurfaceInput,
} from './progressive-surface-fixture.ts'
import {
  authoringContractFromValidity,
  buildRelativeTimeValidity,
  relativeTimeSourceRecords,
} from './relative-time-surface.ts'
import { respondToMockAutomation } from './mock-automation-fixture.ts'
import { isRecord, parseJson, toolCallMessage, toolResultText } from './mock-fixture-support.ts'
import { mockWorkerReportForPrompt, mockWorkerReviewText } from './mock-worker-runner.ts'
import { zonedParts } from './timezone.ts'

/**
 * The Loopback profile's deterministic model (issue #37): this is the
 * `MockResponder` `withMockFallback` (model-routing.ts) resolves to when no
 * provider key is configured. It reproduces the pre-issue-37 chat demo
 * behaviors — meal logging, a "remind me… by <time>" timer, "send to"/
 * "transfer" outbound actions, and a "research <topic>" Worker dispatch —
 * but every one of them now returns a *tool call* for the real Agent loop's
 * gated tool registry to execute, instead of a parallel handler dispatching
 * straight to a tool or a Space mutation itself. Issue #37's acceptance
 * criterion is explicit: "loopback behavior preserved by the mock provider
 * candidate, never through a parallel handler."
 *
 * The meal fixture follows the same information boundary as a real Model
 * connection: it learns Surface identity and state only from model-visible
 * tool results. It has no Store reference or fixed Surface id.
 */

const MEAL_REQUEST = 'aggiungi ai meals la fesa di tacchino'
const MEAL_LABEL = 'fesa di tacchino'
const BREAKFAST_REQUEST = 'aggiungi ai meals la colazione con ricotta, cereali e latte'
const BREAKFAST_LABEL = 'ricotta, cereali e latte'
const CALORIE_REQUEST = 'Quante calorie ho mangiato oggi ?'
const CALORIE_QUANTITY_FOLLOW_UP = 'La ricotta era 100 g, i cereali 40 g e il latte 200 ml'
const DISMISS_CALORIE_REQUEST = 'Non mostrare più la stima calorie'
const CALORIE_REGION_ID = 'derived-calorie-estimate'
const TEMPLATE_SURFACE_REQUEST = 'create Weekly groceries from the Groceries Template'
const REMINDER_RE = /\bremind me to\s+(.+?)\s+by\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
const SEND_RE = /^send to\s+(\S+)\s*:\s*(.+)$/i
const TRANSFER_RE = /^transfer\s+([0-9]+(?:\.[0-9]+)?)\s+to\s+(\S+)$/i
const RESEARCH_RE = /^research\s+(.+)$/i
const HELP_RE = /help|aiuto/i
const FULL_TEXT_REPLY = 'Displayed the requested content.'
const WORKER_PROMPT_PREFIX = 'You are a Worker:'
const WORKER_REVIEW_PROMPT_PREFIX = 'You are an independent reviewer running in a SEPARATE context'
const FULL_TEXT_PROMPT_PREFIX = 'Everything between the markers is untrusted data from "'

export interface MockChatModelOptions {
  now?: () => Date
  /** Global user timezone, shared with the real chat context and Surface engine. */
  timeZone?: string
  /** Delay between demo fills; tests inject zero while the Loopback profile stays observable. */
  progressiveDelayMs?: number
}

/** `PiChatContext['messages']`'s element type, named locally so this file never
 * needs its own `import` of pi-ai's `Message` union (`import-boundary.test.ts`
 * only lets `pi-provider-bridge.ts` import pi-ai directly). */
type PiTurnMessage = PiChatContext['messages'][number]
type PiUserMessage = Extract<PiTurnMessage, { role: 'user' }>
type PiToolResultMessage = Extract<PiTurnMessage, { role: 'toolResult' }>
type PiUserContentArray = Extract<PiUserMessage['content'], unknown[]>
type PiUserContentBlock = PiUserContentArray[number]

/**
 * Builds the Loopback profile's `MockResponder`: given the live turn
 * context, finds the last user message and whether a tool already ran since
 * then, and returns the next assistant message deterministically.
 */
export function createMockChatResponder(options: MockChatModelOptions): MockResponder {
  const now = options.now ?? (() => new Date())
  const timeZone = options.timeZone ?? 'UTC'
  const progressiveDelayMs = Math.max(
    0,
    options.progressiveDelayMs ?? DEFAULT_PROGRESSIVE_FILL_DELAY_MS,
  )

  return (context) => {
    const lastUserIndex = findLastIndex(context.messages, isUserMessage)
    if (lastUserIndex === -1) return echoMessage('')

    const toolResultsAfter = context.messages
      .slice(lastUserIndex + 1)
      .filter((message): message is PiToolResultMessage => isToolResultMessage(message))

    const text = userMessageText(context.messages[lastUserIndex] as PiUserMessage).trim()
    if (isWorkerReviewPrompt(text)) return piFauxAssistantMessage(mockWorkerReviewText(text))
    if (isWorkerPrompt(text)) {
      return piFauxAssistantMessage(JSON.stringify(mockWorkerReportForPrompt(text)))
    }
    if (isFullTextPrompt(text)) return piFauxAssistantMessage(FULL_TEXT_REPLY)
    if (text === MEAL_REQUEST) {
      return respondToMealFixture(toolResultsAfter, now(), timeZone, MEAL_LABEL)
    }
    if (text === BREAKFAST_REQUEST) {
      return respondToMealFixture(toolResultsAfter, now(), timeZone, BREAKFAST_LABEL)
    }
    if (text === CALORIE_REQUEST) return respondToCalorieFixture(toolResultsAfter)
    if (text === CALORIE_QUANTITY_FOLLOW_UP) {
      return respondToCalorieFixture(toolResultsAfter, {
        total: '≈ 470–570 kcal',
        breakfast: '≈ 370–420 kcal',
        caveat: 'Turkey breast quantity is still missing; its value remains an estimate.',
      })
    }
    if (text === DISMISS_CALORIE_REQUEST) return respondToCalorieDismissal(toolResultsAfter)
    if (text === TEMPLATE_SURFACE_REQUEST) {
      return respondToTemplateSurfaceFixture(toolResultsAfter)
    }
    if (text === PROGRESSIVE_SURFACE_REQUEST) {
      return respondToProgressiveSurfaceFixture(toolResultsAfter, now(), progressiveDelayMs)
    }
    const automationResponse = respondToMockAutomation(text, toolResultsAfter)
    if (automationResponse) return automationResponse

    const lastToolResult = toolResultsAfter.at(-1)
    if (lastToolResult) return closingMessage(lastToolResult)
    return respondToUserText(text, now())
  }
}

function isWorkerPrompt(text: string): boolean {
  return text.startsWith(WORKER_PROMPT_PREFIX) && text.includes('Schema (worker-report/v1):')
}

function isWorkerReviewPrompt(text: string): boolean {
  return text.startsWith(WORKER_REVIEW_PROMPT_PREFIX) && text.includes('"verdict":"pass"|"reject"')
}

function isFullTextPrompt(text: string): boolean {
  return (
    text.startsWith(FULL_TEXT_PROMPT_PREFIX) &&
    text.includes('<<<UNTRUSTED full-text from ') &&
    text.endsWith('<<<END full-text>>>')
  )
}

function respondToCalorieDismissal(results: PiToolResultMessage[]): PiAssistantMessage {
  const listResult = results.find((result) => result.toolName === 'list_surfaces')
  if (!listResult) return toolCallMessage('list_surfaces', {}, 'Finding the derived calorie view.')
  const selected = mealsSummary(toolResultText(listResult))
  if (!selected) return piFauxAssistantMessage('No authorable Meals Surface was found.')
  const readResult = results.find((result) => result.toolName === 'read_surface')
  if (!readResult)
    return toolCallMessage(
      'read_surface',
      { surfaceId: selected.id },
      'Reading Meals before recomposing it.',
    )
  const read = surfaceRead(toolResultText(readResult))
  if (!read || read.surface.id !== selected.id)
    return piFauxAssistantMessage('The Meals Surface could not be read safely.')

  const regionIndex =
    read.surface.tree.children?.findIndex((child) => child.id === CALORIE_REGION_ID) ?? -1
  const treePatch = results.find((result) => result.toolName === 'patch_tree')
  if (read.surface.pinned && regionIndex !== -1) {
    if (!treePatch) {
      return toolCallMessage(
        'patch_tree',
        {
          surfaceId: selected.id,
          expectedTreeVersion: read.treeVersion,
          operations: [{ target: 'tree', op: 'remove', path: `/children/${regionIndex}` }],
        },
        'Proposing removal of the derived calorie region while preserving Meals.',
      )
    }
    return piFauxAssistantMessage(
      treePatch.isError
        ? `The pinned Meals composition was not changed: ${toolResultText(treePatch)}`
        : 'A Tree proposal is waiting because Meals is pinned; its state and meal records are unchanged.',
    )
  }
  if (regionIndex !== -1 && !treePatch) {
    return toolCallMessage(
      'patch_tree',
      {
        surfaceId: selected.id,
        expectedTreeVersion: read.treeVersion,
        operations: [{ target: 'tree', op: 'remove', path: `/children/${regionIndex}` }],
      },
      'Removing the derived calorie region while preserving Meals.',
    )
  }
  if (treePatch?.isError) {
    return piFauxAssistantMessage(
      `The visible recomposition did not commit, so its state was left unchanged: ${toolResultText(treePatch)}`,
    )
  }
  const statePatch = results.find((result) => result.toolName === 'patch_state')
  if (!statePatch) {
    const derivedKeys = new Set(['calorieTotal', 'calorieBreakdown', 'calorieCaveat'])
    const operations: PatchOperation[] = []
    for (const key of derivedKeys) {
      if (Object.hasOwn(read.surface.state, key))
        operations.push({ target: 'state', op: 'remove', path: statePath(key) })
    }
    for (const key of read.surface.validity?.projectionStateKeys ?? []) {
      const value = read.surface.state[key]
      if (!derivedKeys.has(key) && value !== undefined)
        operations.push({ target: 'state', op: 'replace', path: statePath(key), value })
    }
    if (operations.length === 0)
      return piFauxAssistantMessage(
        'The calorie view is already absent; meal records were left unchanged.',
      )
    const relativeTime = read.surface.validity
      ? {
          ...authoringContractFromValidity(read.surface.validity),
          projectionStateKeys: read.surface.validity.projectionStateKeys.filter(
            (key) => !derivedKeys.has(key),
          ),
        }
      : undefined
    return toolCallMessage(
      'patch_state',
      { surfaceId: selected.id, operations, ...(relativeTime ? { relativeTime } : {}) },
      'Removing only the derived calorie state.',
    )
  }
  if (statePatch.isError) {
    return piFauxAssistantMessage(
      `The calorie state could not be removed, so the Meals composition was left unchanged: ${toolResultText(statePatch)}`,
    )
  }
  if (regionIndex === -1)
    return piFauxAssistantMessage('The calorie estimate was removed; meal records are unchanged.')
  return piFauxAssistantMessage(
    'The calorie estimate was removed from Meals; all meal records are unchanged.',
  )
}

interface CalorieEstimate {
  total: string
  breakfast: string
  caveat: string
}

const DEFAULT_CALORIE_ESTIMATE: CalorieEstimate = {
  total: '≈ 430–650 kcal',
  breakfast: '≈ 330–500 kcal',
  caveat: 'Missing quantities for ricotta, cereal, milk, and turkey breast; values are estimates.',
}

/** Representative issue #95 journey; production models follow the focused-Space contract. */
function respondToCalorieFixture(
  results: PiToolResultMessage[],
  estimate = DEFAULT_CALORIE_ESTIMATE,
): PiAssistantMessage {
  const listResult = results.find((result) => result.toolName === 'list_surfaces')
  if (!listResult) return toolCallMessage('list_surfaces', {}, 'Checking today’s Meals Surface.')

  const selected = mealsSummary(toolResultText(listResult))
  if (!selected) return piFauxAssistantMessage('No authorable Meals Surface was found.')

  const readResult = results.find((result) => result.toolName === 'read_surface')
  if (!readResult) {
    return toolCallMessage(
      'read_surface',
      { surfaceId: selected.id },
      'Reading all recorded meals.',
    )
  }
  const read = surfaceRead(toolResultText(readResult))
  if (!read || read.surface.id !== selected.id) {
    return piFauxAssistantMessage('The Meals Surface could not be read safely.')
  }

  const statePatch = results.find((result) => result.toolName === 'patch_state')
  if (!statePatch) {
    const relativeTime = read.surface.validity
      ? {
          ...authoringContractFromValidity(read.surface.validity),
          projectionStateKeys: Array.from(
            new Set([
              ...read.surface.validity.projectionStateKeys,
              'calorieTotal',
              'calorieBreakdown',
              'calorieCaveat',
            ]),
          ),
        }
      : undefined
    return toolCallMessage(
      'patch_state',
      {
        surfaceId: selected.id,
        operations: calorieStateOperations(read.surface, estimate),
        ...(relativeTime === undefined ? {} : { relativeTime }),
      },
      `Estimated total: ${estimate.total}. ${estimate.caveat}`,
    )
  }
  if (statePatch.isError) {
    return piFauxAssistantMessage(
      `Estimated total: ${estimate.total}. Meals was not changed because its state update failed: ${toolResultText(statePatch)}`,
    )
  }

  const treePatch = results.find((result) => result.toolName === 'patch_tree')
  if (!treePatch) {
    return toolCallMessage(
      'patch_tree',
      {
        surfaceId: selected.id,
        expectedTreeVersion: read.treeVersion,
        operations: [calorieTreeOperation(read.surface)],
      },
      'Adding the estimate, per-meal breakdown, and missing-quantity caveat to Meals.',
    )
  }

  if (treePatch.isError) {
    return piFauxAssistantMessage(
      `Estimated total: ${estimate.total}. The values were saved, but the visible Meals composition could not be updated: ${toolResultText(treePatch)}`,
    )
  }
  const outcome = toolResultText(treePatch).toLowerCase().includes('proposal')
    ? 'A Tree proposal is waiting because Meals is pinned.'
    : 'Meals now shows the estimate, breakdown, and missing quantities.'
  return piFauxAssistantMessage(`Estimated total: ${estimate.total}. ${outcome}`)
}

function calorieStateOperations(surface: Surface, estimate: CalorieEstimate): PatchOperation[] {
  const values: Array<[string, JsonValue]> = [
    ['calorieTotal', estimate.total],
    [
      'calorieBreakdown',
      [
        { meal: 'Breakfast: ricotta, cereal, milk', estimate: estimate.breakfast },
        { meal: 'Turkey breast', estimate: '≈ 100–150 kcal' },
      ],
    ],
    ['calorieCaveat', estimate.caveat],
  ]
  for (const key of surface.validity?.projectionStateKeys ?? []) {
    const value = surface.state[key]
    if (value !== undefined && !values.some(([candidate]) => candidate === key)) {
      values.push([key, value])
    }
  }
  return values.map(([key, value]) => ({
    target: 'state',
    op: Object.hasOwn(surface.state, key) ? 'replace' : 'add',
    path: statePath(key),
    value,
  }))
}

function calorieTreeOperation(surface: Surface): PatchOperation {
  const region = {
    id: CALORIE_REGION_ID,
    type: 'Box' as const,
    children: [
      { id: 'calorie-title', type: 'Title' as const, props: { text: 'Today’s calorie estimate' } },
      {
        id: 'calorie-total',
        type: 'Stat' as const,
        binding: 'calorieTotal',
        props: { label: 'Estimated total' },
      },
      {
        id: 'calorie-breakdown',
        type: 'Table' as const,
        binding: 'calorieBreakdown',
        props: { columns: ['meal', 'estimate'] },
      },
      {
        id: 'calorie-caveat',
        type: 'Stat' as const,
        binding: 'calorieCaveat',
        props: { label: 'Missing quantities' },
      },
    ],
  }
  const index = surface.tree.children?.findIndex((child) => child.id === CALORIE_REGION_ID) ?? -1
  return {
    target: 'tree',
    op: index === -1 ? 'add' : 'replace',
    path: index === -1 ? `/children/${surface.tree.children?.length ?? 0}` : `/children/${index}`,
    value: region,
  }
}

/**
 * Contributor-facing journey for
 * `issues/029-progressive-surface-composition.md`. It uses the same
 * model-visible tool loop as every other Loopback behavior: publish the full
 * layout first, then emit one versioned patch per resolved region. The image
 * slot stays Pending so the catalog's bounded fallback is observable in a
 * real browser.
 */
async function respondToProgressiveSurfaceFixture(
  results: PiToolResultMessage[],
  at: Date,
  delayMs: number,
): Promise<PiAssistantMessage> {
  const creationResult = results.find((result) => result.toolName === 'create_surface')
  if (!creationResult) {
    return toolCallMessage(
      'create_surface',
      progressiveSurfaceInput(at),
      'Publishing the complete trip layout with Pending regions.',
    )
  }

  const surfaceId = createdSurfaceId(toolResultText(creationResult))
  if (!surfaceId) {
    return piFauxAssistantMessage('The progressive Surface could not be created safely.')
  }

  const failedPatch = results.find((result) => result.toolName === 'patch_tree' && result.isError)
  if (failedPatch) {
    return piFauxAssistantMessage('Progressive composition stopped after a tree patch failed.')
  }

  const completedPatches = results.filter((result) => result.toolName === 'patch_tree').length
  const fill = progressiveFillSteps[completedPatches]
  if (fill === undefined) {
    return piFauxAssistantMessage(
      'The progressive trip plan is ready; the unresolved route preview will visibly fall back when its bounded window expires.',
    )
  }

  await waitForProgressiveFill(delayMs)
  return toolCallMessage(
    'patch_tree',
    {
      surfaceId,
      expectedTreeVersion: completedPatches + 1,
      operations: [fill.operation],
    },
    `Filling ${fill.label}.`,
  )
}

function createdSurfaceId(content: string): string | undefined {
  return /\bcreated Surface\s+(\S+)/.exec(content)?.[1]
}

async function waitForProgressiveFill(delayMs: number): Promise<void> {
  if (delayMs === 0) return
  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs))
}

function respondToTemplateSurfaceFixture(results: PiToolResultMessage[]): PiAssistantMessage {
  const listResult = results.find((result) => result.toolName === 'list_templates')
  if (!listResult) {
    return toolCallMessage(
      'list_templates',
      { intent: 'Groceries' },
      'Looking for the Groceries Template.',
    )
  }

  const template = templateLocation(toolResultText(listResult))
  if (!template) return piFauxAssistantMessage('No matching Groceries Template was found.')

  const creationResult = results.find(
    (result) => result.toolName === 'create_surface_from_template',
  )
  if (creationResult) return closingMessage(creationResult)

  return toolCallMessage(
    'create_surface_from_template',
    {
      templateId: template.templateId,
      templateSpaceId: template.spaceId,
      surfaceId: 'srf-weekly-groceries',
      title: 'Weekly groceries',
    },
    'Creating Weekly groceries from the Groceries Template.',
  )
}

function templateLocation(content: string): { templateId: string; spaceId: string } | undefined {
  const match = /^(tpl-[a-z0-9][a-z0-9-]{0,63}) \(Space ([^)\r\n]+)\)(?:\s|$)/m.exec(content)
  const templateId = match?.[1]
  const spaceId = match?.[2]
  return templateId === undefined || spaceId === undefined ? undefined : { templateId, spaceId }
}

function respondToUserText(text: string, at: Date): PiAssistantMessage {
  const reminder = reminderFromText(text, at)
  if (reminder) {
    return toolCallMessage(
      'arm_timer',
      {
        when: reminder.fireAtIso,
        condition: { kind: 'event-logged', textIncludes: reminder.conditionNeedle },
        action: reminder.action,
      },
      `Armed a reminder to ${reminder.action}.`,
    )
  }

  const send = SEND_RE.exec(text)
  if (send) {
    const [, to, body] = send
    return toolCallMessage('send_message', { to, body }, `Sending a message to ${to}.`)
  }

  const transfer = TRANSFER_RE.exec(text)
  if (transfer) {
    const [, amount, to] = transfer
    return toolCallMessage(
      'transfer_funds',
      { to, amount: Number(amount) },
      `Transferring ${amount} to ${to}.`,
    )
  }

  const research = RESEARCH_RE.exec(text)
  if (research) {
    const topic = research[1]!.trim()
    if (topic) {
      return toolCallMessage(
        'spawn_worker',
        {
          goal: topic,
          tokenBudget: 100_000,
          maxIterations: 6,
          tier: 'reasoning',
          highRisk: true,
        },
        `Researching: ${topic}`,
      )
    }
  }

  return echoMessage(text)
}

/**
 * Scripted model journey for issue 42's Local VPS fixture. The exact
 * sentence selects this deterministic response script; Surface identity and
 * state still come exclusively from prior tool results in the model context.
 */
function respondToMealFixture(
  results: PiToolResultMessage[],
  at: Date,
  timeZone: string,
  meal: string,
): PiAssistantMessage {
  const listResult = results.find((result) => result.toolName === 'list_surfaces')
  if (!listResult) {
    return toolCallMessage('list_surfaces', {}, 'Looking for the Meals Surface.')
  }

  const selected = mealsSummary(toolResultText(listResult))
  if (!selected) return piFauxAssistantMessage('No authorable Meals Surface was found.')

  const readResult = results.find((result) => result.toolName === 'read_surface')
  if (!readResult) {
    return toolCallMessage(
      'read_surface',
      { surfaceId: selected.id },
      'Reading the current Meals state.',
    )
  }

  const read = surfaceRead(toolResultText(readResult))
  if (!read || read.surface.id !== selected.id) {
    return piFauxAssistantMessage('The Meals Surface could not be read safely.')
  }

  const patchResult = results.find((result) => result.toolName === 'patch_state')
  if (patchResult) return closingMessage(patchResult)

  const operations = mealPatchOperations(meal, read.surface, at, timeZone)
  if (!operations) {
    return piFauxAssistantMessage(
      'The Meals Surface has no relative-time source contract, so I did not guess which records belong to today.',
    )
  }

  return toolCallMessage(
    'patch_state',
    {
      surfaceId: read.surface.id,
      operations,
    },
    `Logging: ${meal}.`,
  )
}

interface SurfaceSummary {
  id: string
  title: string
}

function mealsSummary(content: string): SurfaceSummary | undefined {
  const parsed = parseJson(content)
  if (!Array.isArray(parsed)) return undefined
  for (const candidate of parsed) {
    if (!isRecord(candidate)) continue
    const id = candidate['id']
    const title = candidate['title']
    if (typeof id === 'string' && title === 'Meals') return { id, title }
  }
  return undefined
}

function surfaceRead(
  content: string,
): { surface: Surface; version: number; treeVersion: number } | undefined {
  const parsed = parseJson(content)
  if (!isRecord(parsed)) return undefined
  const surface = SurfaceSchema.safeParse(parsed['surface'])
  const version = parsed['version']
  const treeVersion = parsed['treeVersion']
  if (!surface.success || typeof version !== 'number' || typeof treeVersion !== 'number') {
    return undefined
  }
  return { surface: surface.data, version, treeVersion }
}

// ---------------------------------------------------------------------------
// Text-only replies (the pre-issue-37 mock provider's echo logic)
// ---------------------------------------------------------------------------

function echoMessage(text: string): PiAssistantMessage {
  if (text === '') return piFauxAssistantMessage('Say something and I will echo it back.')
  if (HELP_RE.test(text)) {
    return piFauxAssistantMessage(
      'I am the mock provider. The Agent runtime is isolated behind AgentRunner; chat wiring ' +
        'still answers deterministically, with no API key.',
    )
  }
  return piFauxAssistantMessage(`[mock] You said: "${text}".`)
}

/** The follow-up model call after a tool ran: a short, stable closing line. */
function closingMessage(toolResult: PiToolResultMessage): PiAssistantMessage {
  return piFauxAssistantMessage(`Done — ${toolResult.toolName} completed.`)
}

// ---------------------------------------------------------------------------
// Parsing for the other deterministic Loopback fixtures.
// ---------------------------------------------------------------------------

function timeLabel(at: Date, timeZone: string): string {
  const { hour, minute } = zonedParts(timeZone, at)
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function mealPatchOperations(
  meal: string,
  surface: Surface,
  at: Date,
  timeZone: string,
): PatchOperation[] | undefined {
  const storedValidity = surface.validity
  if (!storedValidity) return undefined
  const source = surface.state[storedValidity.source.stateKey]
  if (!Array.isArray(source)) return undefined

  const record = { occurredAt: at.toISOString(), time: timeLabel(at, timeZone), meal }
  const records = [record, ...source.filter(isJsonObject)]
  const validity = buildRelativeTimeValidity(
    authoringContractFromValidity(storedValidity),
    timeZone,
    at,
  )
  const current = relativeTimeSourceRecords(
    { ...surface.state, [storedValidity.source.stateKey]: records },
    validity,
  ).current.sort((left, right) =>
    String(right[storedValidity.source.occurredAtKey]).localeCompare(
      String(left[storedValidity.source.occurredAtKey]),
    ),
  )
  const currentMeals = current
    .filter((entry) => typeof entry['meal'] === 'string')
    .map((entry) => {
      const occurredAt = String(entry[storedValidity.source.occurredAtKey])
      return {
        occurredAt,
        time:
          typeof entry['time'] === 'string'
            ? entry['time']
            : timeLabel(new Date(occurredAt), timeZone),
        meal: entry['meal']!,
      }
    })
  const meals = currentMeals.slice(0, 20)
  const latest = meals[0]

  return [
    {
      target: 'state',
      op: 'replace',
      path: statePath(storedValidity.source.stateKey),
      value: records,
    },
    { target: 'state', op: 'replace', path: '/meals', value: meals },
    {
      target: 'state',
      op: 'replace',
      path: '/lastMeal',
      value: typeof latest?.['meal'] === 'string' ? latest['meal'] : 'Nothing logged today',
    },
    { target: 'state', op: 'replace', path: '/mealCount', value: currentMeals.length },
  ]
}

function statePath(key: string): string {
  return `/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ParsedReminder {
  action: string
  fireAtIso: string
  conditionNeedle: string
}

function reminderFromText(text: string, at: Date): ParsedReminder | undefined {
  const match = REMINDER_RE.exec(text)
  if (!match) return undefined
  const [, rawAction, hourText, minuteText, meridiem] = match

  let hours = Number(hourText)
  if (meridiem?.toLowerCase() === 'pm' && hours < 12) hours += 12
  if (meridiem?.toLowerCase() === 'am' && hours === 12) hours = 0
  const minutes = minuteText === undefined ? 0 : Number(minuteText)
  if (hours > 23 || minutes > 59) return undefined

  const fireAt = new Date(at.getTime())
  fireAt.setHours(hours, minutes, 0, 0)
  if (fireAt.getTime() <= at.getTime()) fireAt.setDate(fireAt.getDate() + 1)

  const action = rawAction!.replace(/[.!?]+$/g, '').trim()
  const needle = action.split(/\s+/).at(-1)
  if (!action || !needle) return undefined
  return { action, fireAtIso: fireAt.toISOString(), conditionNeedle: needle }
}

// ---------------------------------------------------------------------------
// pi-ai message shape helpers
// ---------------------------------------------------------------------------

function isUserMessage(message: PiTurnMessage): message is PiUserMessage {
  return message.role === 'user'
}

function isToolResultMessage(message: PiTurnMessage): message is PiToolResultMessage {
  return message.role === 'toolResult'
}

function isTextBlock(
  block: PiUserContentBlock,
): block is Extract<PiUserContentBlock, { type: 'text' }> {
  return block.type === 'text'
}

function userMessageText(message: PiUserMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join('\n')
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index
  }
  return -1
}
