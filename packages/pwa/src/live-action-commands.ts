import {
  canonicalJson,
  FastActionInvocationSchema,
  RenderableFastActionOutcomeSchema,
  type CommittedFastActionMetadata,
  type FastActionInvocation,
  type JsonObject,
  type RenderableCommittedFastActionOutcome,
  type RenderableFastActionOutcome,
} from '@veduta/protocol'
import type { ActionConfirmation, ActionConfirmations } from '@veduta/catalog'
import { ApiResponseError, ReloadRequiredError } from './api-http.ts'
import {
  persistQueuedFastActions,
  readFastActionQueue,
  type QueuedFastAction,
} from './pwa-storage.ts'

interface CommandOptions {
  storage: Storage
  token: () => string | undefined
  online: () => boolean
  invoke: (surfaceId: string, invocation: FastActionInvocation, token?: string) => Promise<unknown>
  confirmed: (outcome: RenderableCommittedFastActionOutcome) => void
  changed: () => void
  authenticationFailure: (error: ApiResponseError) => void
}

interface Intent {
  entry: QueuedFastAction
  fingerprint: string
  scope: string
  failedLocal: boolean
  superseded: boolean
  retainDraftReceipt: boolean
  receipt?: RenderableFastActionOutcome | CommittedFastActionMetadata
  attempt?: {
    local: boolean
    promise: Promise<void>
    resolve: () => void
    reject: (error: Error) => void
  }
}

/** Intent lifecycle inside the live-state runtime; canonical mutation stays in the Gateway. */
export class LiveActionCommands {
  private readonly intents = new Map<string, Intent>()
  private readonly fingerprints = new Map<string, string>()
  private entries: QueuedFastAction[]
  private started = false
  private generation = 0
  private flushing: Promise<void> | undefined
  private message: string | null
  private readonly confirmed = new Map<
    string,
    {
      surfaceId: string
      nodeId: string
      name: string
      confirmation: ActionConfirmation
    }
  >()
  private confirmedProjection: Record<string, ActionConfirmations> = {}

  constructor(private readonly options: CommandOptions) {
    const queue = readFastActionQueue(options.storage)
    this.entries = queue.entries
    this.message = queue.invalid
      ? 'An incompatible queued action was discarded. Review the Surface before trying again.'
      : null
    for (const entry of this.entries) this.remember(entry)
    if (queue.invalid) this.persist()
  }

  get queued(): QueuedFastAction[] {
    return this.entries
  }
  get error(): string | null {
    return this.message
  }
  get confirmations(): Record<string, ActionConfirmations> {
    return this.confirmedProjection
  }

  acknowledge(surfaceId: string, nodeId: string, name: string, intentId: string): void {
    const scope = canonicalJson({ surfaceId, nodeId, name })
    if (this.confirmed.get(scope)?.confirmation.intentId !== intentId) return
    this.confirmed.delete(scope)
    if (this.intents.get(intentId)?.receipt) this.forget(intentId)
    this.projectConfirmations()
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
      if (intent.attempt?.local) intent.failedLocal = true
      intent.attempt?.reject(
        new Error('The connection changed; this action is queued for confirmation.'),
      )
      delete intent.attempt
    }
  }

  dismissError(): void {
    this.message = null
  }

  dispatch(
    input: {
      surfaceId: string
      nodeId: string
      name: string
      actionRevision: string
      inputs: JsonObject
    },
    retainDraftReceipt = false,
  ): Promise<void> {
    if (!this.started) return Promise.reject(new Error('The Gateway connection is not active.'))
    const scope = canonicalJson({
      surfaceId: input.surfaceId,
      nodeId: input.nodeId,
      name: input.name,
    })
    const fingerprint = canonicalJson(input)
    const existingId = this.fingerprints.get(fingerprint)
    let intent = existingId ? this.intents.get(existingId) : undefined
    if (intent?.receipt) {
      this.forget(intent.entry.id)
      this.message = null
      this.options.changed()
      return Promise.resolve()
    }
    if (!intent) {
      this.confirmed.delete(scope)
      this.projectConfirmations()
      const intentId = crypto.randomUUID()
      const invocation = FastActionInvocationSchema.parse({
        nodeId: input.nodeId,
        name: input.name,
        actionRevision: input.actionRevision,
        intentId,
        inputs: input.inputs,
      })
      intent = this.remember({
        id: intentId,
        surfaceId: input.surfaceId,
        invocation,
        at: new Date().toISOString(),
        status: 'queued',
      })
      this.entries = [...this.entries, intent.entry]
      this.persist()
    }
    intent.retainDraftReceipt = retainDraftReceipt
    return this.send(intent, true)
  }

  /** Called only after the runtime has accepted the canonical Patch delivery. */
  acceptCommittedReceipt(receipt: CommittedFastActionMetadata): void {
    if (!this.started) return
    const intent = this.intents.get(receipt.intentId)
    if (!intent || !matches(intent.entry, receipt)) return
    this.complete(intent, receipt)
  }

  flush(): Promise<void> {
    if (!this.started || !this.options.online()) return Promise.resolve()
    if (this.flushing) return this.flushing
    const generation = this.generation
    const visited = new Set<string>()
    const drain = async () => {
      while (this.started && generation === this.generation && this.options.online()) {
        const entry = this.entries.find((entry) => !visited.has(entry.id))
        if (!entry) break
        visited.add(entry.id)
        const intent = this.intents.get(entry.id) ?? this.remember(entry)
        try {
          await this.send(intent)
        } catch {
          /* The queue and visible error retain the outcome. */
        }
      }
    }
    const flush = drain().finally(() => {
      if (this.flushing === flush) this.flushing = undefined
    })
    this.flushing = flush
    return flush
  }

  private remember(entry: QueuedFastAction): Intent {
    const scope = canonicalJson({
      surfaceId: entry.surfaceId,
      nodeId: entry.invocation.nodeId,
      name: entry.invocation.name,
    })
    for (const [id, previous] of this.intents) {
      if (previous.scope !== scope || id === entry.id) continue
      if (previous.receipt) this.forget(id)
      else {
        previous.superseded = true
        if (this.fingerprints.get(previous.fingerprint) === id)
          this.fingerprints.delete(previous.fingerprint)
      }
    }
    const fingerprint = canonicalJson({
      surfaceId: entry.surfaceId,
      nodeId: entry.invocation.nodeId,
      name: entry.invocation.name,
      actionRevision: entry.invocation.actionRevision,
      inputs: entry.invocation.inputs,
    })
    const intent: Intent = {
      entry,
      fingerprint,
      failedLocal: false,
      superseded: false,
      retainDraftReceipt: false,
      scope,
    }
    this.intents.set(entry.id, intent)
    this.fingerprints.set(fingerprint, entry.id)
    return intent
  }

  private send(intent: Intent, local = false): Promise<void> {
    if (intent.attempt) return intent.attempt.promise
    if (!this.options.online()) {
      if (local) intent.failedLocal = true
      const error = new Error('Gateway offline. This action is queued and has not been confirmed.')
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
    const attempt = { promise, resolve, reject, local }
    intent.attempt = attempt
    this.message = null
    this.options.changed()
    const receive = async () => {
      try {
        const raw = await this.options.invoke(
          intent.entry.surfaceId,
          intent.entry.invocation,
          this.options.token(),
        )
        if (!this.started || generation !== this.generation || intent.attempt !== attempt) return
        const outcome = RenderableFastActionOutcomeSchema.parse(raw)
        if (!matches(intent.entry, outcome))
          throw new Error('The action response has a mismatched identity.')
        if (outcome.outcome === 'recovery_pending') {
          this.entries = this.entries.map((entry) =>
            entry.id === intent.entry.id ? { ...entry, status: 'recovery_pending' } : entry,
          )
          this.persist()
          throw new Error(
            'This action is awaiting Event recovery. Its result has not been confirmed.',
          )
        }
        if (outcome.outcome === 'committed') this.options.confirmed(outcome)
        this.complete(intent, outcome)
      } catch (failure) {
        if (!this.started || generation !== this.generation || intent.attempt !== attempt) return
        const error = failure instanceof Error ? failure : new Error(String(failure))
        if (attempt.local) intent.failedLocal = true
        delete intent.attempt
        if (terminal(error)) {
          this.removeQueued(intent.entry.id)
          this.forget(intent.entry.id)
        }
        this.message = error.message
        reject(error)
        this.options.changed()
        if (error instanceof ApiResponseError && error.status === 401)
          this.options.authenticationFailure(error)
      }
    }
    void receive()
    return promise
  }

  private complete(
    intent: Intent,
    receipt:
      | Exclude<RenderableFastActionOutcome, { outcome: 'recovery_pending' }>
      | CommittedFastActionMetadata,
  ): void {
    if (intent.receipt) return
    intent.receipt = receipt
    if (!intent.superseded) {
      this.confirmed.delete(intent.scope)
      this.confirmed.set(intent.scope, {
        surfaceId: intent.entry.surfaceId,
        nodeId: intent.entry.invocation.nodeId,
        name: intent.entry.invocation.name,
        confirmation: {
          intentId: intent.entry.id,
          actionRevision: intent.entry.invocation.actionRevision,
          inputs: intent.entry.invocation.inputs,
          outcome: receipt.outcome,
        },
      })
    }
    if (this.confirmed.size > 64) {
      const oldest = this.confirmed.keys().next().value
      if (oldest !== undefined) this.confirmed.delete(oldest)
    }
    this.projectConfirmations()
    this.removeQueued(intent.entry.id)
    const attempt = intent.attempt
    delete intent.attempt
    attempt?.resolve()
    if (intent.superseded || !intent.retainDraftReceipt || attempt?.local || !intent.failedLocal)
      this.forget(intent.entry.id)
    if (!intent.superseded) this.message = null
    // Failed local drafts can acknowledge a late receipt once without creating a second intent.
    while (this.intents.size > this.entries.length + 64) {
      const oldest = [...this.intents].find(([, value]) => value.receipt !== undefined)
      if (!oldest) break
      this.forget(oldest[0])
    }
    this.options.changed()
  }

  private removeQueued(id: string): void {
    this.entries = this.entries.filter((entry) => entry.id !== id)
    this.persist()
  }

  private forget(id: string): void {
    const intent = this.intents.get(id)
    if (intent && this.fingerprints.get(intent.fingerprint) === id)
      this.fingerprints.delete(intent.fingerprint)
    this.intents.delete(id)
  }

  private persist(): void {
    persistQueuedFastActions(this.entries, this.options.storage)
  }

  private projectConfirmations(): void {
    const surfaces = new Map<string, Map<string, Map<string, ActionConfirmation>>>()
    for (const value of this.confirmed.values()) {
      const nodes =
        surfaces.get(value.surfaceId) ?? new Map<string, Map<string, ActionConfirmation>>()
      surfaces.set(value.surfaceId, nodes)
      const actions = nodes.get(value.nodeId) ?? new Map<string, ActionConfirmation>()
      nodes.set(value.nodeId, actions)
      actions.set(value.name, value.confirmation)
    }
    this.confirmedProjection = Object.fromEntries(
      [...surfaces].map(([surfaceId, nodes]) => [
        surfaceId,
        Object.fromEntries(
          [...nodes].map(([nodeId, actions]) => [nodeId, Object.fromEntries(actions)]),
        ),
      ]),
    )
  }
}

function matches(
  entry: QueuedFastAction,
  outcome: {
    surfaceId: string
    nodeId: string
    actionName: string
    actionRevision: string
    intentId: string
  },
): boolean {
  const invocation = entry.invocation
  return (
    outcome.surfaceId === entry.surfaceId &&
    outcome.nodeId === invocation.nodeId &&
    outcome.actionName === invocation.name &&
    outcome.actionRevision === invocation.actionRevision &&
    outcome.intentId === invocation.intentId
  )
}

function terminal(error: Error): boolean {
  return (
    error instanceof ReloadRequiredError ||
    (error instanceof ApiResponseError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![408, 429].includes(error.status))
  )
}
