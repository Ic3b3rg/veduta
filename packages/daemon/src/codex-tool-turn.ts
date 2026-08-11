import { canonicalJson } from '@veduta/protocol'
import {
  MAX_RETAINED_NOTIFICATIONS,
  type CodexRequestId,
  type CodexServerRequest,
  type CodexTransport,
} from './codex-app-server.ts'
import {
  AgentMessageDeltaNotificationSchema,
  CODEX_DYNAMIC_TOOL_ITEM_TYPE,
  CODEX_REASONING_ITEM_TYPE,
  CODEX_TEXT_ITEM_TYPE,
  CODEX_USER_ITEM_TYPE,
  CodexProtocolError,
  DynamicToolCallCompletedItemSchema,
  DynamicToolCallParamsSchema,
  DynamicToolCallResponseSchema,
  DynamicToolCallStartedItemSchema,
  ErrorNotificationSchema,
  ItemNotificationSchema,
  parseCodexResponse,
  ThreadStartResponseSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
  type DynamicToolCallCompletedItem,
  type DynamicToolCallResponse,
  type DynamicToolCallStartedItem,
} from './codex-app-server-protocol.ts'
import { ModelConnectionError } from './model-connection-adapter.ts'
import { NonRetryableModelError, sanitizeErrorText } from './model-routing.ts'
import type { SubscriptionStreamEvent, SubscriptionStreamRequest } from './pi-provider-bridge.ts'
import { renderSubscriptionPrompt } from './subscription-prompt.ts'

const TOOL_ACTION_REFUSED_MESSAGE =
  'the Codex turn attempted a tool action; refusing to run a turn that could act outside Veduta'

const TOOL_PROTOCOL_VIOLATION_MESSAGE =
  'the Codex turn violated the pinned dynamic-tool protocol; refusing to expose the call to AgentRunner'

const TURN_ABORTED_MESSAGE = 'the Codex turn was aborted before it completed'
const TURN_FAILED_MESSAGE = 'the Codex provider turn failed without an error message'

/** Bounds one live Codex provider turn, including time spent suspended on a Veduta tool handler. */
export const CODEX_TURN_TIMEOUT_MS = 600_000

const TURN_TIMEOUT_MESSAGE = `the Codex turn exceeded its ${CODEX_TURN_TIMEOUT_MS / 60_000}-minute bound and was abandoned`

type CodexNotificationFrame = { method: string; params: unknown }
type TurnTermination = 'aborted' | 'timeout' | 'protocol-violation'

interface DynamicCallIdentity {
  toolName: string
  input: string
}

interface ActiveCodexTurn {
  transport: CodexTransport
  threadId: string
  turnId: string
  notifications: AsyncIterator<CodexNotificationFrame>
  serverRequests: AsyncIterator<CodexServerRequest>
  replayedNotifications: Set<CodexNotificationFrame>
  nextNotification: Promise<IteratorResult<CodexNotificationFrame>> | undefined
  nextServerRequest: Promise<IteratorResult<CodexServerRequest>> | undefined
  streamedItemIds: Set<string>
  announcedDynamicCalls: Map<string, DynamicCallIdentity>
  acceptedCallIds: Set<string>
  completedCallIds: Set<string>
  expectedDynamicResults: Map<string, DynamicToolCallResponse>
  offeredTools: Set<string>
  termination: Promise<TurnTermination>
  resolveTermination: (reason: TurnTermination) => void
  terminationReason: TurnTermination | undefined
  lifecycleTimer: NodeJS.Timeout | undefined
  abortSignal: AbortSignal | undefined
  abortListener: (() => void) | undefined
  released: boolean
}

interface PendingDynamicToolTurn {
  requestId: CodexRequestId
  toolName: string
  turn: ActiveCodexTurn
}

interface KnownTurns {
  order: string[]
  keys: Set<string>
}

type DynamicToolItem = DynamicToolCallStartedItem | DynamicToolCallCompletedItem

type SubscriptionToolResult = Extract<
  SubscriptionStreamRequest['prompt']['messages'][number],
  { role: 'tool' }
>

const pendingDynamicToolTurns = new WeakMap<CodexTransport, Map<string, PendingDynamicToolTurn>>()
const activeCodexTurns = new WeakMap<CodexTransport, Set<ActiveCodexTurn>>()
const knownCodexTurns = new WeakMap<CodexTransport, KnownTurns>()

function pendingTurnsFor(transport: CodexTransport): Map<string, PendingDynamicToolTurn> {
  const existing = pendingDynamicToolTurns.get(transport)
  if (existing) return existing
  const created = new Map<string, PendingDynamicToolTurn>()
  pendingDynamicToolTurns.set(transport, created)
  return created
}

function activeTurnsFor(transport: CodexTransport): Set<ActiveCodexTurn> {
  const existing = activeCodexTurns.get(transport)
  if (existing) return existing
  const created = new Set<ActiveCodexTurn>()
  activeCodexTurns.set(transport, created)
  return created
}

function knownTurnsFor(transport: CodexTransport): KnownTurns {
  const existing = knownCodexTurns.get(transport)
  if (existing) return existing
  const created = { order: [], keys: new Set<string>() }
  knownCodexTurns.set(transport, created)
  return created
}

function turnKey(threadId: string, turnId: string): string {
  return canonicalJson([threadId, turnId])
}

function rememberTurn(transport: CodexTransport, threadId: string, turnId: string): void {
  const turns = knownTurnsFor(transport)
  const key = turnKey(threadId, turnId)
  if (turns.keys.has(key)) return
  turns.keys.add(key)
  turns.order.push(key)
  while (turns.order.length > MAX_RETAINED_NOTIFICATIONS) {
    const oldest = turns.order.shift()
    if (oldest !== undefined) turns.keys.delete(oldest)
  }
}

function latestToolResult(request: SubscriptionStreamRequest): SubscriptionToolResult | undefined {
  const last = request.prompt.messages.at(-1)
  return last?.role === 'tool' ? last : undefined
}

function isToolArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function releaseTurn(turn: ActiveCodexTurn): Promise<void> {
  if (turn.released) return
  turn.released = true
  if (turn.lifecycleTimer) clearTimeout(turn.lifecycleTimer)
  if (turn.abortListener) turn.abortSignal?.removeEventListener('abort', turn.abortListener)
  const pendingTurns = pendingTurnsFor(turn.transport)
  for (const [callId, pending] of pendingTurns) {
    if (pending.turn === turn) pendingTurns.delete(callId)
  }
  activeTurnsFor(turn.transport).delete(turn)
  await Promise.allSettled([turn.notifications.return?.(), turn.serverRequests.return?.()])
}

async function abandonTurn(turn: ActiveCodexTurn): Promise<void> {
  try {
    await turn.transport.request('turn/interrupt', {
      threadId: turn.threadId,
      turnId: turn.turnId,
    })
  } catch {
    // Best-effort: the live turn stays abandoned when the child has already exited.
  }
}

function terminateTurn(turn: ActiveCodexTurn, reason: TurnTermination): void {
  if (turn.terminationReason !== undefined) return
  turn.terminationReason = reason
  turn.resolveTermination(reason)
  void Promise.allSettled([abandonTurn(turn), releaseTurn(turn)])
}

function refuseToolProtocolViolation(turn: ActiveCodexTurn): never {
  terminateTurn(turn, 'protocol-violation')
  throw new NonRetryableModelError(TOOL_PROTOCOL_VIOLATION_MESSAGE)
}

function refuseProviderNativeAction(turn: ActiveCodexTurn): never {
  terminateTurn(turn, 'protocol-violation')
  throw new NonRetryableModelError(TOOL_ACTION_REFUSED_MESSAGE)
}

function terminationError(reason: TurnTermination): Error {
  if (reason === 'aborted') {
    return new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
  }
  if (reason === 'timeout') {
    return new ModelConnectionError('unreachable', TURN_TIMEOUT_MESSAGE)
  }
  return new NonRetryableModelError(TOOL_PROTOCOL_VIOLATION_MESSAGE)
}

function providerTurnError(message: string | undefined): ModelConnectionError {
  const sanitized = message === undefined ? '' : sanitizeErrorText(message).trim()
  return new ModelConnectionError('unreachable', sanitized || TURN_FAILED_MESSAGE)
}

function armTurnLifecycle(turn: ActiveCodexTurn, signal: AbortSignal | undefined): void {
  turn.lifecycleTimer = setTimeout(() => terminateTurn(turn, 'timeout'), CODEX_TURN_TIMEOUT_MS)
  turn.lifecycleTimer.unref()
  if (signal === undefined) return
  turn.abortSignal = signal
  turn.abortListener = () => terminateTurn(turn, 'aborted')
  if (signal.aborted) {
    terminateTurn(turn, 'aborted')
    return
  }
  signal.addEventListener('abort', turn.abortListener)
}

function belongsToAnotherActiveTurn(
  turn: ActiveCodexTurn,
  threadId: string,
  turnId: string,
): boolean {
  return [...activeTurnsFor(turn.transport)].some(
    (other) => other !== turn && other.threadId === threadId && other.turnId === turnId,
  )
}

function dynamicItemBelongsToTurn(
  turn: ActiveCodexTurn,
  frame: CodexNotificationFrame,
  threadId: string,
  turnId: string,
  callId: string,
): boolean {
  if (threadId === turn.threadId && turnId === turn.turnId) return true

  // A known call changing its outer owner is always a violation, even if
  // the forged owner happens to name another valid turn.
  if (turn.announcedDynamicCalls.has(callId) || turn.acceptedCallIds.has(callId)) {
    refuseToolProtocolViolation(turn)
  }

  // Notification subscriptions replay their bounded pre-turn snapshot.
  // Historical frames and frames owned by another registered turn are
  // unrelated traffic on the shared transport, not this turn's protocol.
  if (
    turn.replayedNotifications.has(frame) ||
    knownTurnsFor(turn.transport).keys.has(turnKey(threadId, turnId))
  ) {
    return false
  }

  refuseToolProtocolViolation(turn)
}

function dynamicIdentity(turn: ActiveCodexTurn, item: DynamicToolItem): DynamicCallIdentity {
  if (
    item.namespace != null ||
    !turn.offeredTools.has(item.tool) ||
    !isToolArguments(item.arguments)
  ) {
    refuseToolProtocolViolation(turn)
  }
  return { toolName: item.tool, input: canonicalJson(item.arguments) }
}

function completionMatchesResponse(
  item: DynamicToolCallCompletedItem,
  response: DynamicToolCallResponse,
): boolean {
  return (
    item.status === (response.success ? 'completed' : 'failed') &&
    item.success === response.success &&
    canonicalJson(item.contentItems) === canonicalJson(response.contentItems)
  )
}

async function startTurn(
  transport: CodexTransport,
  codexHome: string,
  request: SubscriptionStreamRequest,
): Promise<ActiveCodexTurn> {
  const threadStartRaw = await transport.request('thread/start', {
    model: request.modelId,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    config: { web_search: 'disabled', disabled_tools: true },
    dynamicTools: request.prompt.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    cwd: codexHome,
  })
  const {
    thread: { id: threadId },
  } = parseCodexResponse(ThreadStartResponseSchema, 'thread/start', threadStartRaw)

  if (request.signal?.aborted) {
    throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
  }

  const notifications = transport.notifications()[Symbol.asyncIterator]()
  // These objects are the same retained-frame references the iterator's
  // snapshot will replay. Capturing them after subscription creation but
  // before `turn/start` distinguishes history from this fresh turn.
  const replayedNotifications = new Set(transport.recentNotifications())
  const serverRequests = transport.serverRequests()[Symbol.asyncIterator]()
  try {
    const turnStartRaw = await transport.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: renderSubscriptionPrompt(request.prompt) }],
    })
    const {
      turn: { id: turnId },
    } = parseCodexResponse(TurnStartResponseSchema, 'turn/start', turnStartRaw)
    let resolveTermination!: (reason: TurnTermination) => void
    const termination = new Promise<TurnTermination>((resolve) => {
      resolveTermination = resolve
    })
    const turn: ActiveCodexTurn = {
      transport,
      threadId,
      turnId,
      notifications,
      serverRequests,
      replayedNotifications,
      nextNotification: undefined,
      nextServerRequest: undefined,
      streamedItemIds: new Set<string>(),
      announcedDynamicCalls: new Map<string, DynamicCallIdentity>(),
      acceptedCallIds: new Set<string>(),
      completedCallIds: new Set<string>(),
      expectedDynamicResults: new Map<string, DynamicToolCallResponse>(),
      offeredTools: new Set(request.prompt.tools.map((tool) => tool.name)),
      termination,
      resolveTermination,
      terminationReason: undefined,
      lifecycleTimer: undefined,
      abortSignal: undefined,
      abortListener: undefined,
      released: false,
    }
    activeTurnsFor(transport).add(turn)
    rememberTurn(transport, threadId, turnId)
    armTurnLifecycle(turn, request.signal)
    return turn
  } catch (error) {
    await Promise.allSettled([notifications.return?.(), serverRequests.return?.()])
    throw error
  }
}

async function* continueTurn(
  turn: ActiveCodexTurn,
): AsyncGenerator<SubscriptionStreamEvent, void, void> {
  let handedOff = false
  try {
    while (true) {
      if (turn.terminationReason !== undefined) throw terminationError(turn.terminationReason)
      turn.nextNotification ??= turn.notifications.next()
      turn.nextServerRequest ??= turn.serverRequests.next()
      const outcome = await Promise.race([
        turn.nextNotification.then((result) => ({ kind: 'notification' as const, result })),
        turn.nextServerRequest.then((result) => ({ kind: 'server-request' as const, result })),
        turn.termination.then((reason) => ({ kind: 'terminated' as const, reason })),
      ])

      if (outcome.kind === 'terminated') throw terminationError(outcome.reason)

      if (outcome.kind === 'server-request') {
        turn.nextServerRequest = undefined
        if (outcome.result.done) {
          throw new ModelConnectionError(
            'unreachable',
            'the Codex transport ended its server-request stream',
          )
        }
        const frame = outcome.result.value
        if (frame.method !== 'item/tool/call') refuseProviderNativeAction(turn)
        const call = parseCodexResponse(DynamicToolCallParamsSchema, frame.method, frame.params)
        if (call.threadId !== turn.threadId || call.turnId !== turn.turnId) {
          if (belongsToAnotherActiveTurn(turn, call.threadId, call.turnId)) continue
          refuseToolProtocolViolation(turn)
        }
        if (
          !turn.offeredTools.has(call.tool) ||
          call.namespace != null ||
          !isToolArguments(call.arguments)
        ) {
          refuseToolProtocolViolation(turn)
        }
        const announced = turn.announcedDynamicCalls.get(call.callId)
        if (
          announced === undefined ||
          announced.toolName !== call.tool ||
          announced.input !== canonicalJson(call.arguments)
        ) {
          refuseToolProtocolViolation(turn)
        }
        const callIdOwner = [...activeTurnsFor(turn.transport)].find((active) =>
          active.acceptedCallIds.has(call.callId),
        )
        if (callIdOwner !== undefined) refuseToolProtocolViolation(turn)
        turn.acceptedCallIds.add(call.callId)
        pendingTurnsFor(turn.transport).set(call.callId, {
          requestId: frame.id,
          toolName: call.tool,
          turn,
        })
        handedOff = true
        yield {
          type: 'tool-call',
          toolCallId: call.callId,
          toolName: call.tool,
          input: call.arguments,
        }
        return
      }

      turn.nextNotification = undefined
      if (outcome.result.done) {
        throw new ModelConnectionError(
          'unreachable',
          'the Codex transport ended its notification stream',
        )
      }
      const frame = outcome.result.value

      if (frame.method === 'error') {
        const failed = parseCodexResponse(ErrorNotificationSchema, frame.method, frame.params)
        if (failed.threadId !== turn.threadId || failed.turnId !== turn.turnId) continue
        if (!failed.willRetry) throw providerTurnError(failed.error.message)
        continue
      }

      if (frame.method === 'turn/completed') {
        const completed = parseCodexResponse(
          TurnCompletedNotificationSchema,
          frame.method,
          frame.params,
        )
        if (completed.threadId !== turn.threadId || completed.turn.id !== turn.turnId) continue
        if (completed.turn.status === 'failed') {
          throw providerTurnError(completed.turn.error?.message)
        }
        if (completed.turn.status === 'interrupted') {
          throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
        }
        if (completed.turn.status === 'inProgress') refuseToolProtocolViolation(turn)
        if (
          turn.announcedDynamicCalls.size !== turn.completedCallIds.size ||
          turn.acceptedCallIds.size !== turn.completedCallIds.size ||
          turn.expectedDynamicResults.size !== 0
        ) {
          refuseToolProtocolViolation(turn)
        }
        return
      }

      if (frame.method === 'item/agentMessage/delta') {
        const parsed = parseCodexResponse(
          AgentMessageDeltaNotificationSchema,
          frame.method,
          frame.params,
        )
        if (parsed.threadId !== turn.threadId || parsed.turnId !== turn.turnId) continue
        turn.streamedItemIds.add(parsed.itemId)
        if (parsed.delta) yield { type: 'text-delta', text: parsed.delta }
        continue
      }

      if (frame.method !== 'item/started' && frame.method !== 'item/completed') continue

      const parsed = parseCodexResponse(ItemNotificationSchema, frame.method, frame.params)
      const { item } = parsed
      if (item.type === CODEX_DYNAMIC_TOOL_ITEM_TYPE) {
        if (!dynamicItemBelongsToTurn(turn, frame, parsed.threadId, parsed.turnId, item.id))
          continue
        if (frame.method === 'item/started') {
          const dynamicItem = parseCodexResponse(
            DynamicToolCallStartedItemSchema,
            frame.method,
            item,
          )
          const identity = dynamicIdentity(turn, dynamicItem)
          if (
            turn.announcedDynamicCalls.has(dynamicItem.id) ||
            turn.acceptedCallIds.has(dynamicItem.id)
          ) {
            refuseToolProtocolViolation(turn)
          }
          turn.announcedDynamicCalls.set(dynamicItem.id, identity)
          continue
        }

        const completedItem = parseCodexResponse(
          DynamicToolCallCompletedItemSchema,
          frame.method,
          item,
        )
        const identity = dynamicIdentity(turn, completedItem)
        const announced = turn.announcedDynamicCalls.get(completedItem.id)
        const expected = turn.expectedDynamicResults.get(completedItem.id)
        if (
          turn.completedCallIds.has(completedItem.id) ||
          !turn.acceptedCallIds.has(completedItem.id) ||
          announced?.toolName !== identity.toolName ||
          announced.input !== identity.input ||
          expected === undefined ||
          !completionMatchesResponse(completedItem, expected)
        ) {
          refuseToolProtocolViolation(turn)
        }
        turn.expectedDynamicResults.delete(completedItem.id)
        turn.completedCallIds.add(completedItem.id)
        continue
      }

      if (parsed.threadId !== turn.threadId || parsed.turnId !== turn.turnId) continue
      if (item.type === CODEX_TEXT_ITEM_TYPE) {
        if (frame.method === 'item/completed' && !turn.streamedItemIds.has(item.id) && item.text) {
          yield { type: 'text-delta', text: item.text }
        }
        continue
      }
      if (item.type === CODEX_USER_ITEM_TYPE || item.type === CODEX_REASONING_ITEM_TYPE) continue
      refuseProviderNativeAction(turn)
    }
  } catch (error) {
    if (error instanceof CodexProtocolError) refuseToolProtocolViolation(turn)
    throw error
  } finally {
    if (!handedOff) await releaseTurn(turn)
  }
}

/**
 * Owns one structured Codex provider turn across AgentRunner's repeated
 * model-call loop. The adapter supplies transport and isolation paths;
 * this coordinator alone owns correlation, suspension, and interruption.
 */
export async function* streamCodexToolTurn(
  transport: CodexTransport,
  codexHome: string,
  request: SubscriptionStreamRequest,
): AsyncGenerator<SubscriptionStreamEvent, void, void> {
  const toolResult = latestToolResult(request)
  const pending =
    toolResult === undefined ? undefined : pendingTurnsFor(transport).get(toolResult.toolCallId)

  if (toolResult !== undefined && pending === undefined) {
    throw new NonRetryableModelError(TOOL_PROTOCOL_VIOLATION_MESSAGE)
  }

  if (toolResult !== undefined && pending !== undefined) {
    pendingTurnsFor(transport).delete(toolResult.toolCallId)
    if (toolResult.toolName !== pending.toolName) refuseToolProtocolViolation(pending.turn)
    if (request.signal?.aborted) {
      terminateTurn(pending.turn, 'aborted')
      throw new ModelConnectionError('unsupported', TURN_ABORTED_MESSAGE)
    }
    const response = parseCodexResponse(DynamicToolCallResponseSchema, 'item/tool/call response', {
      success: !toolResult.isError,
      contentItems: [
        {
          type: 'inputText',
          text: toolResult.isError ? sanitizeErrorText(toolResult.text) : toolResult.text,
        },
      ],
    })
    pending.turn.expectedDynamicResults.set(toolResult.toolCallId, response)
    try {
      await transport.respond(pending.requestId, response)
    } catch (error) {
      void abandonTurn(pending.turn)
      await releaseTurn(pending.turn)
      throw error
    }
    yield* continueTurn(pending.turn)
    return
  }

  let turn: ActiveCodexTurn
  try {
    turn = await startTurn(transport, codexHome, request)
  } catch (error) {
    if (error instanceof CodexProtocolError) {
      throw new NonRetryableModelError(TOOL_PROTOCOL_VIOLATION_MESSAGE)
    }
    throw error
  }
  yield* continueTurn(turn)
}
