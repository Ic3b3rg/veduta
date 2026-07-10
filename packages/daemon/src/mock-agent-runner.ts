import {
  AgentEventBus,
  MemorySessionStore,
  type AgentEvent,
  type AgentPromptOptions,
  type AgentRunner,
  type ModelRef,
  type SessionStore,
  type ToolDef,
} from './agent-runner.ts'
import { effectiveOrigin, gateToolsForOrigins, isUntrusted, type Origin } from './taint.ts'

const MOCK_MODEL: ModelRef = { provider: 'mock', modelId: 'mock-agent-runner', tier: 'triage' }
const DEFAULT_USER_ORIGIN: Origin = 'trusted:user'
const CANNED_REPLY = 'Displayed the requested content.'

/**
 * Deterministic, zero-network `AgentRunner` (mock-first dev, same spirit as
 * `mockReply` and the scheduler's stub judge — dev works with no VPS,
 * domain, or provider key, by design). It honors the taint half of the
 * `AgentRunner` contract well enough to exercise the full-text flow and
 * chat wiring end-to-end without a real provider: it appends the user
 * message with its origin, gates the offered tools through
 * `gateToolsForOrigins` (exposing the gated list via `lastGatedTools` for
 * assertions), and emits a canned, content-free assistant reply that
 * inherits the untrusted origin per the derivation rule (v3 §B.5) — it
 * never echoes anything from inside the prompt, so it cannot itself be a
 * laundering vector.
 */
export class MockAgentRunner implements AgentRunner {
  private readonly events = new AgentEventBus()
  private readonly sessionStore: SessionStore
  private sessionId: string | undefined = undefined

  /** The tools admitted to the most recent `prompt()` call, after the taint gate. */
  lastGatedTools: ToolDef[] = []

  constructor(sessionStore: SessionStore = new MemorySessionStore()) {
    this.sessionStore = sessionStore
  }

  async start(sessionId: string): Promise<void> {
    this.sessionId = sessionId
  }

  async prompt(input: string, options: AgentPromptOptions = {}): Promise<void> {
    if (!this.sessionId) {
      const message = 'MockAgentRunner.start must be called before prompt'
      await this.events.emit({ type: 'error', message })
      throw new Error(message)
    }
    const sessionId = this.sessionId
    const promptOrigin = options.origin ?? DEFAULT_USER_ORIGIN
    // Session-message origins count too, mirroring PiAgentRunner: a session
    // tainted by an earlier turn keeps gating later ones ("swap the runner
    // instance, nothing else" must hold for re-taint semantics as well).
    const sessionOrigins = (await this.sessionStore.load(sessionId)).messages.map(
      (message) => message.origin,
    )
    const candidateOrigins: (Origin | undefined)[] = [
      promptOrigin,
      ...(options.contextOrigins ?? []),
      ...sessionOrigins,
    ]
    const turnOrigin = effectiveOrigin(candidateOrigins, promptOrigin)
    this.lastGatedTools = gateToolsForOrigins(options.tools ?? [], candidateOrigins)

    if (options.retryOfFailedTurn !== true) {
      await this.sessionStore.append(sessionId, {
        type: 'message',
        message: {
          role: 'user',
          content: input,
          ...(promptOrigin === DEFAULT_USER_ORIGIN ? {} : { origin: promptOrigin }),
        },
      })
    }

    await this.sessionStore.append(sessionId, {
      type: 'message',
      message: {
        role: 'assistant',
        content: CANNED_REPLY,
        ...(isUntrusted(turnOrigin) ? { origin: turnOrigin } : {}),
      },
    })

    await this.events.emit({
      type: 'turn-end',
      sessionId,
      model: options.model ?? MOCK_MODEL,
      text: CANNED_REPLY,
    })
  }

  abort(): void {}

  on(handler: (event: AgentEvent) => Promise<void> | void): () => void {
    return this.events.on(handler)
  }
}
