import {
  AgentActionInvocationSchema,
  AgentActionResultSchema,
  canonicalJson,
  type AgentActionInvocation,
  type AgentActionTurn,
  type JsonObject,
} from '@veduta/protocol'
import type { ActionConfirmations } from '@veduta/catalog'
import { z } from 'zod'
import { ApiResponseError } from './api-http.ts'

const QUEUE_KEY = 'veduta.agentActionQueue'
const EntrySchema = z
  .object({
    surfaceId: z.string().min(1),
    invocation: AgentActionInvocationSchema.extend({ idempotencyKey: z.string().uuid() }),
  })
  .strict()
type Entry = z.infer<typeof EntrySchema>
interface Intent {
  entry: Entry
  fingerprint: string
  receipt?: AgentActionTurn
  attempt?: { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
}

/** Agent waits and retry identities belong to the live runtime, alongside fast Action intents. */
export class LiveAgentActionCommands {
  private readonly intents = new Map<string, Intent>()
  private readonly latest = new Map<string, string>()
  private readonly confirmations = new Map<
    string,
    { surfaceId: string; nodeId: string; name: string; value: ActionConfirmations[string][string] }
  >()
  private started = false
  private generation = 0
  private flushing: Promise<void> | undefined
  private message: string | null = null

  constructor(
    private readonly options: {
      storage: Storage
      token: () => string | undefined
      online: () => boolean
      invoke: (
        surfaceId: string,
        invocation: AgentActionInvocation,
        token?: string,
      ) => Promise<unknown>
      confirmed: (turn: Extract<AgentActionTurn, { status: 'completed' }>) => Promise<void>
      changed: () => void
      authenticationFailure: (error: ApiResponseError) => void
    },
  ) {
    try {
      const parsed = z
        .array(EntrySchema)
        .safeParse(JSON.parse(options.storage.getItem(QUEUE_KEY) ?? '[]'))
      if (!parsed.success) throw new Error('Invalid Agent action queue')
      for (const entry of parsed.data) {
        if (this.intents.has(entry.invocation.idempotencyKey))
          throw new Error('Repeated Agent identity')
        this.remember(entry)
      }
    } catch {
      this.intents.clear()
      this.message =
        'An incompatible queued Agent action was discarded. Review the Surface before retrying.'
      this.persist()
    }
  }

  get error(): string | null {
    return this.message
  }

  get actionConfirmations(): Record<string, ActionConfirmations> {
    const result: Record<string, ActionConfirmations> = {}
    for (const entry of this.confirmations.values()) {
      const nodes = (result[entry.surfaceId] ??= {})
      const actions = (nodes[entry.nodeId] ??= {})
      actions[entry.name] = entry.value
    }
    return result
  }

  acknowledge(surfaceId: string, nodeId: string, name: string, intentId: string): void {
    const key = canonicalJson({ surfaceId, nodeId, name })
    if (this.confirmations.get(key)?.value.intentId !== intentId) return
    this.confirmations.delete(key)
    this.options.changed()
  }

  start(): void {
    this.started = true
  }

  stop(): void {
    this.started = false
    this.disconnect()
  }

  disconnect(): void {
    this.generation += 1
    this.flushing = undefined
    for (const intent of this.intents.values()) {
      intent.attempt?.reject(
        new Error('The connection changed; the Agent action awaits confirmation.'),
      )
      delete intent.attempt
      delete intent.receipt
    }
  }

  dismissError(): void {
    this.message = null
  }

  dispatch(surfaceId: string, nodeId: string, name: string, payload: JsonObject): Promise<void> {
    if (!this.started) return Promise.reject(new Error('The Gateway connection is not active.'))
    const fingerprint = canonicalJson({ surfaceId, nodeId, name, payload })
    const previous = [...this.intents.values()].find((intent) => intent.fingerprint === fingerprint)
    const intent =
      previous ??
      this.remember({
        surfaceId,
        invocation: { nodeId, name, payload, idempotencyKey: crypto.randomUUID() },
      })
    this.latest.set(
      canonicalJson({ surfaceId, nodeId, name }),
      intent.entry.invocation.idempotencyKey,
    )
    this.persist()
    return this.send(intent)
  }

  accept(turn: AgentActionTurn): void {
    if (!this.started || !turn.idempotencyKey) return
    const intent = this.intents.get(turn.idempotencyKey)
    if (
      !intent ||
      turn.surfaceId !== intent.entry.surfaceId ||
      turn.atomId !== intent.entry.invocation.nodeId ||
      turn.actionName !== intent.entry.invocation.name ||
      intent.receipt ||
      (turn.status !== 'completed' && turn.status !== 'failed')
    )
      return
    intent.receipt = turn
    const generation = this.generation
    const finish = async () => {
      try {
        if (turn.status === 'completed') await this.options.confirmed(turn)
      } catch (failure) {
        if (generation !== this.generation || !this.started) return
        delete intent.receipt
        this.reject(intent, failure instanceof Error ? failure : new Error(String(failure)))
        return
      }
      if (generation !== this.generation || !this.started) return
      this.intents.delete(turn.idempotencyKey!)
      this.persist()
      const attempt = intent.attempt
      delete intent.attempt
      if (turn.status === 'failed') {
        this.message = turn.error
        attempt?.reject(new Error(turn.error))
      } else {
        const scope = canonicalJson({
          surfaceId: turn.surfaceId,
          nodeId: turn.atomId,
          name: turn.actionName,
        })
        if (this.latest.get(scope) === turn.idempotencyKey)
          this.confirmations.set(scope, {
            surfaceId: turn.surfaceId,
            nodeId: turn.atomId,
            name: turn.actionName,
            value: {
              path: 'agent',
              intentId: turn.idempotencyKey!,
              turnId: turn.id,
              payload: intent.entry.invocation.payload ?? {},
              outcome: 'completed',
            },
          })
        if (this.confirmations.size > 64) {
          const oldest = this.confirmations.keys().next().value
          if (oldest !== undefined) this.confirmations.delete(oldest)
        }
        this.message = null
        attempt?.resolve()
      }
      this.options.changed()
    }
    void finish()
  }

  flush(): Promise<void> {
    if (!this.started || !this.options.online()) return Promise.resolve()
    if (this.flushing) return this.flushing
    const generation = this.generation
    const entries = [...this.intents.values()]
    const flush = (async () => {
      for (const intent of entries) {
        if (!this.started || generation !== this.generation || !this.options.online()) break
        try {
          await this.send(intent)
        } catch {
          // Retained identities replay the original turn after the next connection.
        }
      }
    })().finally(() => {
      if (this.flushing === flush) this.flushing = undefined
    })
    this.flushing = flush
    return flush
  }

  private remember(entry: Entry): Intent {
    const { idempotencyKey: _, ...invocation } = entry.invocation
    const intent: Intent = {
      entry,
      fingerprint: canonicalJson({
        surfaceId: entry.surfaceId,
        nodeId: invocation.nodeId,
        name: invocation.name,
        payload: invocation.payload,
      }),
    }
    this.intents.set(entry.invocation.idempotencyKey, intent)
    this.latest.set(
      canonicalJson({
        surfaceId: entry.surfaceId,
        nodeId: invocation.nodeId,
        name: invocation.name,
      }),
      entry.invocation.idempotencyKey,
    )
    return intent
  }

  private send(intent: Intent): Promise<void> {
    if (intent.attempt) return intent.attempt.promise
    if (!this.options.online()) {
      const error = new Error('Gateway offline. The Agent action is queued and has not completed.')
      this.message = error.message
      this.options.changed()
      return Promise.reject(error)
    }
    const generation = this.generation
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((done, failed) => {
      resolve = done
      reject = failed
    })
    const attempt = { promise, resolve, reject }
    intent.attempt = attempt
    this.message = null
    const receive = async () => {
      try {
        const raw = await this.options.invoke(
          intent.entry.surfaceId,
          intent.entry.invocation,
          this.options.token(),
        )
        if (!this.started || generation !== this.generation || intent.attempt !== attempt) return
        const result = AgentActionResultSchema.parse(raw)
        if (
          result.turn.idempotencyKey !== intent.entry.invocation.idempotencyKey ||
          result.turn.surfaceId !== intent.entry.surfaceId ||
          result.turn.atomId !== intent.entry.invocation.nodeId ||
          result.turn.actionName !== intent.entry.invocation.name
        )
          throw new Error('The Agent action response has a mismatched identity.')
        this.accept(result.turn)
      } catch (failure) {
        if (!this.started || generation !== this.generation || intent.attempt !== attempt) return
        if (intent.receipt) return
        this.reject(intent, failure instanceof Error ? failure : new Error(String(failure)))
      }
    }
    void receive()
    this.options.changed()
    return promise
  }

  private reject(intent: Intent, error: Error): void {
    const attempt = intent.attempt
    delete intent.attempt
    if (
      error instanceof ApiResponseError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 429].includes(error.status)
    ) {
      this.intents.delete(intent.entry.invocation.idempotencyKey)
      this.persist()
    }
    this.message = error.message
    attempt?.reject(error)
    this.options.changed()
    if (error instanceof ApiResponseError && error.status === 401)
      this.options.authenticationFailure(error)
  }

  private persist(): void {
    this.options.storage.setItem(
      QUEUE_KEY,
      JSON.stringify([...this.intents.values()].map((intent) => intent.entry)),
    )
  }
}
