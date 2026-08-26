import { randomUUID } from 'node:crypto'
import type {
  ChatResultTarget,
  GatewayServerMessage,
  PendingDecision,
  Space,
} from '@veduta/protocol'
import type { SessionContextFilter, SessionMessage, SessionStore, ToolDef } from './agent-runner.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import type { ModelRouter } from './model-routing.ts'
import { sanitizeErrorText } from './model-routing.ts'
import { PiAgentRunner } from './pi-agent-runner.ts'
import type { ProviderBridge } from './pi-provider-bridge.ts'
import type { GlobalChatTurnHooks } from './global-chat-tools.ts'
import { ABSTENTION_RULE, renderEventForContext } from './spaces-engine.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { effectiveOrigin, type Origin } from './taint.ts'
import { zonedParts } from './timezone.ts'
import { piToolParameters } from './tool-parameters.ts'

/**
 * Chat inside a Space: the Agent has the Space's assembled context and its
 * gated tool registry, so it can act, not just talk.
 */
const SPACE_CHAT_PREAMBLE =
  "You are Veduta's Agent, answering the user's chat message inside this Space. Use the " +
  'tools available to you for Space work — reading recent events, writing facts, creating ' +
  'or updating Surfaces, arming timers — rather than only describing what you would do. ' +
  'Surface authoring also applies when a read-only question produces a structured result that is ' +
  'useful to keep visible at a glance — for example an estimate, comparison, summary, breakdown, ' +
  'progress view, plan, or timeline. Ordinary conversation and answers with no useful visual ' +
  'payoff stay chat-only. When a request can affect Surface content or has such a visual result, ' +
  'call list_surfaces and identify every Surface in ' +
  'this Space affected by the message. Call read_surface for each applicable Surface, then derive ' +
  'patch_state or patch_tree from what was returned. For each applicable Surface, update every ' +
  'dependent state field needed to keep its visible content internally consistent, including ' +
  'summaries, counts, histories, and progress values. Do not stop after the first applicable ' +
  'Surface or state field. Enrich the Surface that owns the concern or source data; create a ' +
  'Surface only when the result is a distinct durable concern or none fits. Replace an existing ' +
  'derived region instead of appending answer snapshots. When a result is superseded or dismissed, ' +
  'remove only its derived state and Atoms, preserving source records and unrelated content; archive ' +
  'a separate Agent-authored Surface when its whole concern is no longer useful. If none fits, use ' +
  'create_surface. Show uncertainty, ranges, missing inputs, and caveats in the Surface. When a new Surface has regions ' +
  'that become ready independently, create the complete layout with Pending leaf Atoms, then ' +
  'replace each Pending Atom in place with a separate patch_tree as its content becomes ready. ' +
  'Preserve its id so the client gives only that region an entrance transition without ' +
  're-animating resolved siblings. A newly created Surface starts at tree version 1; each ' +
  'committed patch_tree increments it by one, and after a conflict call read_surface before ' +
  'retrying. Never leave a Pending Atom unresolved after composition fails: replace it with a ' +
  "visible explanatory Atom when possible; the client's bounded timeout is the last-resort " +
  'fallback. When visible state represents a relative calendar window such as today, this week, ' +
  'or this month, declare relativeTime when creating it (or on the first state patch of a legacy ' +
  'Surface). Keep a separate durable source array and give every new source record an ISO ' +
  'occurredAt for the effective real-world time. Use the current user-local clock and timezone ' +
  'below as authoritative, preserve older source records, exclude undated legacy records from ' +
  "the projection, and update every declared projectionStateKey in the same patch. read_surface's " +
  'relativeTime status and caveat are authoritative; never present an expired projection as ' +
  'current. append_event does not change a ' +
  'Surface or its visible state and is never a substitute for a Surface mutation. Only claim a ' +
  'Surface changed after a successful mutation tool result.'

const TOOL_BOUNDARY =
  'Use only the Veduta tools explicitly provided in this turn. Never call provider-native shell, ' +
  'command, filesystem, web, MCP, or any other tool not supplied by Veduta.'

const GLOBAL_SPACE_ROSTER_LIMIT = 50

const GLOBAL_CHAT_PREAMBLE =
  "You are Veduta's single Agent in the global chat. You can selectively read and act across " +
  "active Spaces without changing the user's current route. Resolve targets honestly from the " +
  "user's request and the active roster. When exactly one existing Space is unambiguous, act " +
  'directly: call enter_space before any scoped tool, then pass that Space id or slug as spaceId. ' +
  'Enter every target again on each turn; an earlier conversational summary never replaces its ' +
  'current Space context. ' +
  'When multiple Spaces are plausible, ask the user which one they mean and make no tool call or ' +
  'write. When no existing Space fits, use propose_space and stop before creating a Space or ' +
  'Surface; only the user can accept the one-tap proposal. One turn may enter and work in multiple ' +
  'Spaces: enter each relevant Space separately, coordinate them here in this one Agent, and keep ' +
  'every scoped call assigned to its own Space. Never infer a target merely because it appears ' +
  'first in the roster. Workers remain optional, asynchronous, investigate-and-report executions ' +
  'scoped to exactly one entered Space; you retain the final decision.'

const SYSTEM_CHAT_PREAMBLE =
  "You are Veduta's Agent, answering conversationally inside the canonical Gateway-owned System Space. " +
  'This Space is only for Veduta status and controls. Use list_surfaces, read_surface, and ' +
  'list_automations only as read-only status tools. Only invoke a Gateway operation when a ' +
  'dedicated tool for that operation is explicitly present in this turn. Never create or patch ' +
  'ordinary Surfaces here. Do not write FACTS or INSTRUCTIONS, author Templates or Automations, ' +
  'spawn Workers, or use outbound actions from this Space. If the user asks to store or manage ' +
  'personal content, do not silently change scope: explain that the System Space cannot own that ' +
  'content and visibly direct the user to an appropriate user life-area Space from the roster ' +
  'below, or to global chat when none fits. Actions declared by a daemon-owned System Surface ' +
  'continue through their declared fast or Agent path; never imitate one with a generic write.'

/**
 * Keep the conversational transcript, but never carry a previous turn's
 * Space context or scoped tool arguments/results into a new global turn.
 * Current-turn tool messages stay intact so the Agent can continue after an
 * `enter_space` or mutation call. Historical assistant messages are cloned
 * so the runner reconstructs text-only messages rather than preserving old
 * provider tool-call blocks whose matching results were removed.
 */
const GLOBAL_CHAT_CONTEXT_FILTER: SessionContextFilter = (messages, { phase }) => {
  let currentTurnStart = -1
  if (phase === 'turn') {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === 'user') {
        currentTurnStart = index
        break
      }
    }
  }

  const historyEnd = currentTurnStart < 0 ? messages.length : currentTurnStart
  const conversation = messages.slice(0, historyEnd).flatMap(conversationMessage)
  return currentTurnStart < 0
    ? conversation
    : [...conversation, ...messages.slice(currentTurnStart)]
}

function conversationMessage(message: SessionMessage): SessionMessage[] {
  if (message.role === 'tool') return []
  if (message.role === 'assistant') {
    return message.content.trim() === '' ? [] : [{ ...message }]
  }
  return [message]
}

export interface ChatLoopOptions {
  store: Store
  router: ModelRouter
  /** Constructed by the caller (`PiJsonlSessionStore` under `<rootDir>/sessions`). */
  sessionStore: SessionStore
  /** Bundles `resolveModel`/`getApiKey`/`streamFn` — the real provider bridge (issue #37) or a test double shaped like one (`fake-provider.ts`). */
  bridge: ProviderBridge
  isTrustWrapped: (tool: ToolDef) => boolean
  /** Focused tools, or the stable scoped global registry with per-turn result hooks. */
  toolsFor: (spaceId: string | undefined, hooks?: GlobalChatTurnHooks) => ToolDef[]
  send: (clientId: string, frame: GatewayServerMessage) => void
  /** Clock and global user timezone injected into every turn's context. */
  now?: () => Date
  timeZone?: string
}

export interface ChatLoop {
  /** Resolves when the turn fully completes (frames sent, events appended) — callers may void it. */
  handleChatMessage(event: NormalizedChannelEvent): Promise<void>
  /**
   * Graceful shutdown (issue #37 fix): marks the loop stopped so any new
   * `handleChatMessage` call short-circuits with a `chat.turn-error` frame
   * instead of starting a turn, aborts every live runner (`PiAgentRunner.abort()`,
   * which aborts pi's own in-flight stream), and awaits every session's
   * current serialization chain so this resolves only once every turn this
   * loop ever started has either finished or been aborted — the contract
   * `server.ts`'s `onClose` hook needs before the stores those turns write
   * to (the Event log, the session store) start tearing down themselves.
   */
  stop(): Promise<void>
}

/** `space:<spaceId>` for a Space turn, `global` for the global chat — persistent, derivable pi session ids. */
function sessionIdFor(spaceId: string | undefined): string {
  return spaceId === undefined ? 'global' : `space:${spaceId}`
}

/**
 * The assistant's final text: each model call's segment joined with a blank
 * line, falling back to the last `turn-end` text when nothing streamed at
 * all. A multi-model-call turn (a tool call followed by a closing model
 * call) must not run its segments together with no separator — see the
 * `runTurn` doc comment on `segments`/`pendingSeparator`.
 */
function finalTextOf(segments: string[], lastTurnEndText: string | undefined): string {
  return segments.length > 0 ? segments.join('\n\n') : lastTurnEndText || ''
}

function addResultTarget(targets: ChatResultTarget[], target: ChatResultTarget): void {
  const sameSurface = targets.findIndex(
    (candidate) => candidate.spaceId === target.spaceId && candidate.surfaceId === target.surfaceId,
  )
  if (sameSurface >= 0) {
    targets[sameSurface] = target
    return
  }
  if (target.surfaceId === undefined) {
    if (targets.some((candidate) => candidate.spaceId === target.spaceId)) return
  } else {
    const spaceOnly = targets.findIndex(
      (candidate) => candidate.spaceId === target.spaceId && candidate.surfaceId === undefined,
    )
    if (spaceOnly >= 0) targets.splice(spaceOnly, 1)
  }
  if (targets.length < 20) targets.push(target)
}

function activeLifeAreaRoster(store: Store): string {
  const spaces = store.listSpaces().filter((space) => space.id !== SYSTEM_SPACE_ID)
  const roster = spaces.slice(0, GLOBAL_SPACE_ROSTER_LIMIT)
  const omitted = spaces.length - roster.length
  const lines = roster
    .map((space) => `- ${space.name} (slug: ${space.slug}; id: ${space.id})`)
    .join('\n')
  if (lines.length === 0) return 'No active user life-area Spaces yet.'
  return `${lines}${omitted > 0 ? `\nShowing the first ${roster.length}; ${omitted} additional active Spaces omitted.` : ''}`
}

export function createChatLoop(options: ChatLoopOptions): ChatLoop {
  const now = options.now ?? (() => new Date())
  const timeZone = options.timeZone ?? 'UTC'
  const runners = new Map<string, PiAgentRunner>()
  // One turn in flight per session id, because PiAgentRunner holds mutable
  // turn state (issue #37): the fullTextChain idiom (server.ts), keyed per
  // session rather than a single global tail so Spaces don't serialize
  // against each other.
  const chains = new Map<string, Promise<unknown>>()
  // Set once by `stop()` (issue #37 fix): checked at the top of every new
  // `handleChatMessage` call, never reset — a stopped chat loop stays
  // stopped for the rest of the process's life.
  let stopped = false

  async function getRunner(sessionId: string, spaceId: string | undefined): Promise<PiAgentRunner> {
    const existing = runners.get(sessionId)
    if (existing) return existing
    // `piToolParameters` is computed once here, when the runner for this
    // session is first created, but `toolsFor` runs again on every turn
    // (`runTurn`'s `options.toolsFor(spaceId)` below) to build that turn's
    // gated registry. The two must therefore agree on tool NAMES for this
    // session's whole lifetime — `PiAgentRunner.toPiTools` throws "missing pi
    // parameters" for any tool name `toolsFor` returns later that was not
    // present in this snapshot (issue #37). Every registry `toolsFor` can
    // build today is static per focused or global session, so this holds; it would break the
    // moment a registry's tool set could vary turn-to-turn for the same
    // session (e.g. a future per-turn feature flag on tool availability).
    const runner = new PiAgentRunner({
      sessionStore: options.sessionStore,
      resolveModel: options.bridge.resolveModel,
      getApiKey: options.bridge.getApiKey,
      streamFn: options.bridge.streamFn,
      toolParameters: piToolParameters(options.toolsFor(spaceId)),
      isToolTrustWrapped: options.isTrustWrapped,
    })
    await runner.start(sessionId)
    runners.set(sessionId, runner)
    return runner
  }

  function buildContext(spaceId: string | undefined): {
    systemPrompt: string
    contextOrigins: Origin[]
  } {
    const { year, month, day, hour, minute } = zonedParts(timeZone, now())
    const twoDigits = (value: number): string => String(value).padStart(2, '0')
    const clock =
      `Current user-local date and time: ${year}-${twoDigits(month)}-${twoDigits(day)} ` +
      `${twoDigits(hour)}:${twoDigits(minute)} (${timeZone}).`
    if (spaceId === SYSTEM_SPACE_ID) {
      const docs = options.store.readGlobalDocs()
      const space = options.store.getSpace(SYSTEM_SPACE_ID)
      if (!space) throw new Error(`unknown Space: ${SYSTEM_SPACE_ID}`)
      const recentEvents = options.store.spacesEngine.readRecent(SYSTEM_SPACE_ID, 20)
      const recent =
        recentEvents.length === 0
          ? 'No recent Event log entries.'
          : recentEvents.map(renderEventForContext).join('\n')
      return {
        systemPrompt: [
          `# SOUL\n\n${docs.soul.trim()}`,
          `# USER\n\n${docs.user.trim()}`,
          `# Active Space\n\n${space.name} (${space.slug}; id: ${space.id})`,
          `# Recent Event log\n\n${recent}`,
          `# User life-area Spaces\n\n${activeLifeAreaRoster(options.store)}`,
          ABSTENTION_RULE,
          clock,
          TOOL_BOUNDARY,
          SYSTEM_CHAT_PREAMBLE,
        ].join('\n\n'),
        contextOrigins: Array.from(new Set(recentEvents.map((event) => event.origin))),
      }
    }
    if (spaceId !== undefined) {
      return {
        systemPrompt: [
          options.store.assembleSpaceContext(spaceId),
          ABSTENTION_RULE,
          clock,
          TOOL_BOUNDARY,
          SPACE_CHAT_PREAMBLE,
        ].join('\n\n'),
        contextOrigins: options.store.spacesEngine.contextOrigins(spaceId),
      }
    }
    const docs = options.store.readGlobalDocs()
    const systemPrompt = [
      `# SOUL\n\n${docs.soul.trim()}`,
      `# USER\n\n${docs.user.trim()}`,
      `# Active Spaces\n\n${activeLifeAreaRoster(options.store)}`,
      ABSTENTION_RULE,
      clock,
      TOOL_BOUNDARY,
      GLOBAL_CHAT_PREAMBLE,
    ].join('\n\n')
    return { systemPrompt, contextOrigins: [] }
  }

  async function runTurn(
    event: NormalizedChannelEvent,
    spaceId: string | undefined,
  ): Promise<void> {
    const turnId = randomUUID()
    const spaceField = spaceId === undefined ? {} : { spaceId }
    const enteredSpaces = new Map<string, Space>()
    const resultTargets: ChatResultTarget[] = []
    const pendingDecisions: PendingDecision[] = []
    const globalHooks: GlobalChatTurnHooks | undefined =
      spaceId === undefined
        ? {
            onSpaceEntered(space) {
              if (enteredSpaces.has(space.id)) return
              options.store.spacesEngine.appendEvent(space.id, {
                type: 'turn',
                text: event.text,
                origin: 'trusted:user',
                payload: { role: 'user', correlationId: turnId },
              })
              enteredSpaces.set(space.id, space)
            },
            onResultTarget(target) {
              addResultTarget(resultTargets, target)
            },
            onPendingDecision(decision) {
              const existing = pendingDecisions.findIndex(
                (candidate) => candidate.id === decision.id,
              )
              if (existing >= 0) pendingDecisions[existing] = decision
              else if (pendingDecisions.length < 10) pendingDecisions.push(decision)
            },
          }
        : undefined
    options.send(event.clientId, { type: 'chat.turn-start', turnId, ...spaceField })

    try {
      const sessionId = sessionIdFor(spaceId)
      const runner = await getRunner(sessionId, spaceId)
      const { systemPrompt, contextOrigins } = buildContext(spaceId)
      const turnTools = options.toolsFor(spaceId, globalHooks)

      if (spaceId !== undefined) {
        options.store.spacesEngine.appendEvent(spaceId, {
          type: 'turn',
          text: event.text,
          origin: 'trusted:user',
          payload: { role: 'user' },
        })
      }

      // A `turn-end` `AgentEvent` fires once per model call pi issues, not
      // once per whole logical turn: a tool call followed by a closing model
      // call is TWO `turn-end` events inside one `runner.prompt()`. `segments`
      // collects each call's completed text (`currentSegment`, reset on every
      // `turn-end`); a call with no text of its own (a tool-call-only step)
      // contributes nothing, so it never introduces a spurious blank
      // separator. `pendingSeparator` defers emitting the joining blank
      // line as a delta until the NEXT real text actually arrives — set
      // only after a non-empty segment closes, so the streamed view a
      // client reconstructs from deltas ends up identical to `finalTextOf`'s
      // joined text, never a trailing or leading separator.
      //
      // All five of these are reset at the start of every `router.execute`
      // attempt (see the executor passed below), not just declared once
      // outside it: a retryable failure can stream real text through
      // `text-delta` before the attempt fails (a provider error carrying
      // partial content), and without a reset the next attempt's genuine
      // reply would concatenate onto that stale, discarded prefix instead of
      // replacing it. The client may show that stale prefix transiently —
      // `chat-turn-state.ts`'s `applyTurnFrame` REPLACES the accumulated
      // text wholesale on `chat.turn-end` rather than appending to it, so
      // the final rendered message is never affected.
      let segments: string[] = []
      let currentSegment = ''
      let pendingSeparator = false
      let toolCalls: { toolCallId: string; toolName: string }[] = []
      let lastTurnEnd: { text: string; origins: Origin[] } | undefined

      function resetPerAttemptAccumulation(): void {
        segments = []
        currentSegment = ''
        pendingSeparator = false
        toolCalls = []
        lastTurnEnd = undefined
      }

      // A delivery/accounting failure (a dead `send`, a `recordSpend` throw)
      // must never alter turn control flow: this subscriber runs awaited
      // inside the runner's own event bus (`AgentEventBus.emit`), so an
      // uncaught exception would propagate into `agent.prompt()`'s rejection
      // path, and `ModelRouter.execute` would misclassify it as a retryable
      // model failure — possibly re-running an already-completed turn.
      // Only the externally-observable operations are guarded (same
      // "observer failed" shape as `spaces-engine.ts`'s memory-write
      // observer); the accumulator updates stay OUTSIDE the guard, because
      // skipping them on a swallowed delivery error would end the turn with
      // an empty "successful" reply and Event entry.
      const guarded = (operation: () => void): void => {
        try {
          operation()
        } catch (error) {
          console.error('chat loop turn observer failed', error)
        }
      }
      const unsubscribe = runner.on((agentEvent) => {
        if (agentEvent.type === 'text-delta') {
          const emitSeparator = pendingSeparator
          pendingSeparator = false
          currentSegment += agentEvent.text
          guarded(() => {
            if (emitSeparator) {
              options.send(event.clientId, {
                type: 'chat.turn-delta',
                turnId,
                ...spaceField,
                text: '\n\n',
              })
            }
            options.send(event.clientId, {
              type: 'chat.turn-delta',
              turnId,
              ...spaceField,
              text: agentEvent.text,
            })
          })
          return
        }
        if (agentEvent.type === 'tool-start') {
          toolCalls.push({ toolCallId: agentEvent.toolCallId, toolName: agentEvent.toolName })
          return
        }
        if (agentEvent.type === 'turn-end') {
          lastTurnEnd = { text: agentEvent.text, origins: agentEvent.origins ?? [] }
          const segment = currentSegment || agentEvent.text
          if (segment) {
            segments.push(segment)
            pendingSeparator = true
          }
          currentSegment = ''
          if (agentEvent.costUsd !== undefined) {
            const { model, costUsd } = agentEvent
            guarded(() => options.router.recordSpend(model, costUsd))
          }
        }
      })

      try {
        await options.router.execute(
          { purpose: 'chat-turn', origin: 'user', ...spaceField },
          (model, attempt) => {
            // Reset before every attempt, not just the first: a failed
            // attempt may have already streamed (and accumulated) partial
            // text before erroring out, and this attempt's own text must
            // start from nothing, never concatenate onto a discarded
            // candidate's output.
            resetPerAttemptAccumulation()
            return runner.prompt(event.text, {
              model,
              tools: turnTools,
              systemPrompt,
              origin: 'trusted:user',
              contextOrigins,
              ...(spaceId === undefined ? { contextFilter: GLOBAL_CHAT_CONTEXT_FILTER } : {}),
              ...spaceField,
              trigger: { kind: 'chat', summary: event.text },
              initiatingTurn: { clientId: event.clientId, turnId },
              retryOfFailedTurn: attempt > 0,
            })
          },
        )
      } finally {
        unsubscribe()
      }

      const finalText = finalTextOf(segments, lastTurnEnd?.text)

      if (spaceId !== undefined) {
        // A turn that read untrusted content mid-turn must not launder its
        // output into trusted context (docs/SECURITY.md §3.2): the assistant
        // turn inherits the most-untrusted origin the turn actually saw,
        // not a blanket trusted mark.
        const assistantOrigin = effectiveOrigin(lastTurnEnd?.origins ?? [], 'trusted:system')
        options.store.spacesEngine.appendEvent(spaceId, {
          type: 'turn',
          text: finalText,
          origin: assistantOrigin,
          payload: { role: 'assistant', toolCalls },
        })
      } else {
        appendGlobalTerminalEvents(enteredSpaces, {
          text: finalText,
          origin: effectiveOrigin(lastTurnEnd?.origins ?? [], 'trusted:system'),
          payload: { role: 'assistant', correlationId: turnId, toolCalls },
        })
      }

      options.send(event.clientId, {
        type: 'chat.turn-end',
        turnId,
        ...spaceField,
        message: {
          role: 'assistant',
          text: finalText,
          ...(resultTargets.length === 0 ? {} : { targets: resultTargets }),
          ...(pendingDecisions.length === 0 ? {} : { pendingDecisions }),
        },
      })
    } catch (error) {
      const errorText = sanitizeErrorText(error)
      if (spaceId === undefined) {
        const enteredOrigins = [...enteredSpaces.keys()].flatMap((enteredSpaceId) =>
          options.store.spacesEngine.contextOrigins(enteredSpaceId),
        )
        appendGlobalTerminalEvents(enteredSpaces, {
          text: `Global turn failed: ${errorText}`,
          origin: effectiveOrigin(enteredOrigins, 'trusted:system'),
          payload: { role: 'assistant', correlationId: turnId, outcome: 'failed' },
        })
      }
      options.send(event.clientId, {
        type: 'chat.turn-error',
        turnId,
        ...spaceField,
        error: errorText,
      })
    }
  }

  function appendGlobalTerminalEvents(
    spaces: Map<string, Space>,
    input: {
      text: string
      origin: Origin
      payload: NonNullable<Parameters<Store['spacesEngine']['appendEvent']>[1]['payload']>
    },
  ): void {
    for (const enteredSpaceId of spaces.keys()) {
      try {
        options.store.spacesEngine.appendEvent(enteredSpaceId, {
          type: 'turn',
          text: input.text,
          origin: input.origin,
          payload: input.payload,
        })
      } catch (error) {
        console.error(`global chat terminal Event write failed for Space ${enteredSpaceId}`, error)
      }
    }
  }

  async function handleChatMessage(event: NormalizedChannelEvent): Promise<void> {
    if (stopped) {
      // Same lifecycle contract as the unknown-Space path below: an error
      // frame always closes a turn its own `chat.turn-start` opened.
      const turnId = randomUUID()
      const spaceField = event.spaceId === undefined ? {} : { spaceId: event.spaceId }
      options.send(event.clientId, { type: 'chat.turn-start', turnId, ...spaceField })
      options.send(event.clientId, {
        type: 'chat.turn-error',
        turnId,
        ...spaceField,
        error: 'The daemon is shutting down; please try again once it restarts.',
      })
      return
    }

    const spaceId = event.spaceId
    if (spaceId !== undefined && !options.store.getSpace(spaceId)) {
      // A `chat.turn-error` frame must always be preceded by its own
      // `chat.turn-start` (the same `turnId`): every other exit from this
      // loop opens a turn before it can ever close one, and a client
      // tracking turns by `turnId` (`chat-turn-state.ts`'s `applyTurnFrame`)
      // would otherwise see an error frame with no turn to close.
      const turnId = randomUUID()
      options.send(event.clientId, { type: 'chat.turn-start', turnId, spaceId })
      options.send(event.clientId, {
        type: 'chat.turn-error',
        turnId,
        spaceId,
        error: `unknown Space: ${spaceId}`,
      })
      return
    }

    const sessionId = sessionIdFor(spaceId)
    const previous = chains.get(sessionId) ?? Promise.resolve()
    // Failed links never poison the chain: `runTurn` catches its own
    // failure and reports it as a `chat.turn-error` frame instead of
    // rejecting, but the `.catch(() => {})` guards the chain itself against
    // any future change to that contract.
    const next = previous.catch(() => {}).then(() => runTurn(event, spaceId))
    chains.set(sessionId, next)
    return next
  }

  async function stop(): Promise<void> {
    stopped = true
    // Abort every live runner's in-flight stream (`PiAgentRunner.abort()` ->
    // `Agent.abort()`) before waiting on the chains below: an aborted
    // `agent.prompt()` settles (as a rejection `runTurn`'s own try/catch
    // already handles), which is what lets each session's chain actually
    // resolve instead of hanging on a turn that would otherwise run to
    // completion on its own schedule.
    for (const runner of runners.values()) runner.abort()
    // `allSettled`, not `all`: a chain rejecting must not stop this from
    // waiting on every other session's chain too — `stop()`'s job is to wait
    // out every turn this loop ever started, not to propagate any one of
    // their failures (`runTurn` already turns its own failures into a
    // `chat.turn-error` frame rather than a chain rejection, but `stop()`
    // must tolerate one regardless).
    await Promise.allSettled([...chains.values()])
  }

  return { handleChatMessage, stop }
}
