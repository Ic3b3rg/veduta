import {
  SurfaceSchema,
  type JsonObject,
  type JsonValue,
  type PatchOperation,
  type Surface,
} from '@veduta/protocol'
import {
  piFauxAssistantMessage,
  piFauxText,
  piFauxToolCall,
  type MockResponder,
  type PiAssistantMessage,
  type PiChatContext,
} from './pi-provider-bridge.ts'

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

/** Historical fallback Space (the pre-issue-37 chat stand-ins used the same
 * default): global chat's `systemPrompt` (chat-loop.ts's `buildContext`) has
 * no Active Space section at all, so the reminder branch below — the one
 * branch whose tool schema requires `spaceId` as a call argument rather than
 * reading it off `ToolContext` — falls back to this Space, exactly like the
 * stand-ins it replaces.
 */
const DEFAULT_SPACE_ID = 'spc-health'

/**
 * `spaces-engine.ts`'s `assembleContext` renders the turn's active Space as
 * a `# Active Space` section whose first line is `<name> (<slug>)`
 * (`section()`'s heading rule); Space ids are always `spc-<slug>`
 * (`spaces-engine.ts`'s `createSpace`). Parsed straight out of
 * `context.systemPrompt` — pi-ai's `Context` carries no Space identity of
 * its own, only `systemPrompt`/`messages`/`tools` — since that is the only
 * place a Space chat turn's own identity survives into the mock model.
 */
const ACTIVE_SPACE_RE = /# Active Space\n\n.*\(([^()]+)\)/

/** The turn's active Space id, parsed from the systemPrompt's Active Space section; `DEFAULT_SPACE_ID` for global chat, which has no such section. */
function activeSpaceId(context: PiChatContext): string {
  const match = ACTIVE_SPACE_RE.exec(context.systemPrompt ?? '')
  return match?.[1] ? `spc-${match[1]}` : DEFAULT_SPACE_ID
}

const MEAL_REQUEST = 'aggiungi ai meals la fesa di tacchino'
const MEAL_LABEL = 'fesa di tacchino'
const TEMPLATE_SURFACE_REQUEST = 'create Weekly groceries from the Groceries Template'
const PROGRESSIVE_SURFACE_REQUEST = 'show progressive surface demo'
const DEFAULT_PROGRESSIVE_FILL_DELAY_MS = 1_200
const REMINDER_RE = /\bremind me to\s+(.+?)\s+by\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i
const SEND_RE = /^send to\s+(\S+)\s*:\s*(.+)$/i
const TRANSFER_RE = /^transfer\s+([0-9]+(?:\.[0-9]+)?)\s+to\s+(\S+)$/i
const RESEARCH_RE = /^research\s+(.+)$/i
const HELP_RE = /help|aiuto/i

export interface MockChatModelOptions {
  now?: () => Date
  /** Delay between progressive demo fills; tests inject zero while the dev profile stays observable. */
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
    if (text === MEAL_REQUEST) return respondToMealFixture(toolResultsAfter, now())
    if (text === TEMPLATE_SURFACE_REQUEST) {
      return respondToTemplateSurfaceFixture(toolResultsAfter)
    }
    if (text === PROGRESSIVE_SURFACE_REQUEST) {
      return respondToProgressiveSurfaceFixture(toolResultsAfter, now(), progressiveDelayMs)
    }

    const lastToolResult = toolResultsAfter.at(-1)
    if (lastToolResult) return closingMessage(lastToolResult)
    return respondToUserText(text, now(), activeSpaceId(context))
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
  const fill = progressiveFills[completedPatches]
  if (!fill) {
    return piFauxAssistantMessage(
      'The progressive trip plan is ready; the route preview remains Pending to demonstrate its bounded fallback.',
    )
  }

  await waitForProgressiveFill(delayMs)
  return toolCallMessage(
    'patch_tree',
    {
      surfaceId,
      expectedTreeVersion: completedPatches + 1,
      operations: [fill],
    },
    `Filling ${progressiveFillLabels[completedPatches]}.`,
  )
}

function progressiveSurfaceInput(at: Date): Record<string, unknown> {
  return {
    id: `srf-progressive-${at.getTime()}`,
    title: 'Progressive trip plan',
    intent: 'Progressive trip planning demo',
    justification: 'This contributor demo must expose independent Pending regions and fallback.',
    tree: {
      id: 'progressive-root',
      type: 'Box',
      props: { gap: 'md' },
      children: [
        {
          id: 'progressive-title',
          type: 'Title',
          props: { text: 'Liguria road trip', level: 2 },
        },
        {
          id: 'progressive-caption',
          type: 'Caption',
          props: { text: 'Regions fill independently; the route preview demonstrates fallback.' },
        },
        {
          id: 'progressive-summary',
          type: 'Pending',
          props: { variant: 'text', label: 'Trip summary', lines: 3 },
        },
        {
          id: 'progressive-metrics',
          type: 'Row',
          props: { gap: 'md' },
          children: [
            {
              id: 'progressive-distance-column',
              type: 'Col',
              children: [
                {
                  id: 'progressive-distance',
                  type: 'Pending',
                  props: { variant: 'stat', label: 'Total distance' },
                },
              ],
            },
            {
              id: 'progressive-chart-column',
              type: 'Col',
              children: [
                {
                  id: 'progressive-chart',
                  type: 'Pending',
                  props: { variant: 'chart', label: 'Distance by day' },
                },
              ],
            },
          ],
        },
        {
          id: 'progressive-stops',
          type: 'Pending',
          props: { variant: 'list', label: 'Suggested stops', rows: 2 },
        },
        {
          id: 'progressive-route',
          type: 'Pending',
          props: { variant: 'image', label: 'Route preview', timeoutMs: 8_000 },
        },
      ],
    },
    state: {},
  }
}

const progressiveFills: readonly PatchOperation[] = [
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
]

const progressiveFillLabels = ['the summary', 'the distance', 'the chart', 'the stops'] as const

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

function respondToUserText(text: string, at: Date, spaceId: string): PiAssistantMessage {
  const reminder = reminderFromText(text, at)
  if (reminder) {
    return toolCallMessage(
      'arm_timer',
      {
        spaceId,
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
function respondToMealFixture(results: PiToolResultMessage[], at: Date): PiAssistantMessage {
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

  return toolCallMessage(
    'patch_state',
    {
      surfaceId: read.surface.id,
      operations: mealPatchOperations(MEAL_LABEL, read.surface.state, at),
    },
    `Logging: ${MEAL_LABEL}.`,
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

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function toolCallMessage(
  name: string,
  args: Record<string, unknown>,
  text: string,
): PiAssistantMessage {
  return piFauxAssistantMessage([piFauxText(text), piFauxToolCall(name, args)], {
    stopReason: 'toolUse',
  })
}

// ---------------------------------------------------------------------------
// Parsing for the other deterministic Loopback fixtures.
// ---------------------------------------------------------------------------

// Daemon-local wall-clock time: the Surface shows "when I ate", not UTC.
function timeLabel(at: Date): string {
  return at.toTimeString().slice(0, 5)
}

function mealPatchOperations(meal: string, state: JsonObject, at: Date): PatchOperation[] {
  const existing = Array.isArray(state['meals']) ? state['meals'].filter(isJsonObject) : []
  const meals = [{ time: timeLabel(at), meal }, ...existing].slice(0, 20)
  // Counted apart from the display list, which is truncated to 20 entries.
  const count = typeof state['mealCount'] === 'number' ? state['mealCount'] + 1 : meals.length

  return [
    { target: 'state', op: 'replace', path: '/meals', value: meals },
    { target: 'state', op: 'replace', path: '/lastMeal', value: meal },
    { target: 'state', op: 'replace', path: '/mealCount', value: count },
  ]
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

function toolResultText(message: PiToolResultMessage): string {
  return message.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n')
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index] as T)) return index
  }
  return -1
}
