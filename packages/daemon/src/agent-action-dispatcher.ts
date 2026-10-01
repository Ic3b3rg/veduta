import { type AgentActionTurn } from '@veduta/protocol'
import type { ChatLoop } from './chat-loop.ts'
import { sanitizeErrorText } from './model-routing.ts'
import type { Store } from './store.ts'
import { agentActionTurnSummary, type QueuedAgentTurn } from './surface-engine.ts'

/** Executes durable Surface requests in the existing single Agent loop. */
export class AgentActionDispatcher {
  private readonly running = new Map<string, Promise<AgentActionTurn>>()
  private stopped = false

  constructor(
    private readonly options: {
      store: Store
      loop: ChatLoop
      publish: (turn: AgentActionTurn) => void
    },
  ) {}

  async recover(): Promise<void> {
    for (const interrupted of this.options.store.interruptAgentTurns()) this.publish(interrupted)
    await Promise.allSettled(
      this.options.store.queuedAgentTurns().map((turn) => this.execute(turn)),
    )
  }

  execute(requested: QueuedAgentTurn): Promise<AgentActionTurn> {
    const inFlight = this.running.get(requested.id)
    if (inFlight) return inFlight
    const current = this.options.store.agentTurn(requested.id)
    if (!current) return Promise.reject(new Error('The queued Agent action is unavailable.'))
    if (current.status !== 'queued') return Promise.resolve(agentActionTurnSummary(current))
    if (this.stopped) {
      const failed = this.options.store.finishAgentTurn(current.id, {
        error: 'The daemon is shutting down; the action was not executed.',
      })
      if (!failed) return Promise.reject(new Error('The queued Agent action is unavailable.'))
      this.publish(failed)
      return Promise.resolve(agentActionTurnSummary(failed))
    }
    this.options.store.assertSpaceReadyForAgent(current.spaceId)
    const claimed = this.options.store.claimAgentTurn(current.id)
    if (!claimed)
      return Promise.resolve(agentActionTurnSummary(this.options.store.agentTurn(current.id)!))
    this.publish(claimed)
    const execution = (async () => {
      let finished: QueuedAgentTurn | undefined
      try {
        const result = await this.options.loop.handleAgentAction(claimed)
        finished = this.options.store.finishAgentTurn(
          claimed.id,
          'message' in result
            ? { message: result.message, surfaceCursor: this.options.store.latestSurfaceCursor() }
            : result,
        )
      } catch (error) {
        finished = this.options.store.finishAgentTurn(claimed.id, {
          error: sanitizeErrorText(error),
        })
      }
      if (!finished) throw new Error('The completed Agent action is unavailable.')
      this.publish(finished)
      return agentActionTurnSummary(finished)
    })().finally(() => this.running.delete(current.id))
    this.running.set(current.id, execution)
    return execution
  }

  async stop(): Promise<void> {
    this.stopped = true
    await this.options.loop.stop()
    await Promise.allSettled([...this.running.values()])
  }

  private publish(turn: QueuedAgentTurn): void {
    try {
      this.options.publish(agentActionTurnSummary(turn))
    } catch (error) {
      console.error('Agent action status observer failed', error)
    }
  }
}
