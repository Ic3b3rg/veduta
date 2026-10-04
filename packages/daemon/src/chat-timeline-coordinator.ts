import { randomUUID } from 'node:crypto'
import type {
  ChatAcceptance,
  ChatScope,
  ChatTimelineEntry,
  GatewayServerMessage,
  PendingDecision,
} from '@veduta/protocol'
import type { PwaChatInput } from './gateway.ts'
import type { ChatTimeline } from './chat-timeline.ts'
import type { ServiceConnections } from './service-connections.ts'
import { boundedServiceIntent, targetSpaceForServiceRequest } from './service-intent.ts'

/** Owns Chat acceptance and dispatch. The Agent loop never decides whether a turn is replayed. */
export class ChatTimelineCoordinator {
  private readonly executing = new Map<string, Promise<void>>()
  private readonly clients = new Map<string, string>()
  private readonly subscribers = new Map<string, Set<string>>()
  private stopping = false

  constructor(
    private readonly options: {
      timeline: ChatTimeline
      hasSpace: (spaceId: string) => boolean
      runTurn: (event: PwaChatInput) => Promise<void>
      publish: (entry: ChatTimelineEntry) => void
      refreshDecision?: (
        id: string,
      ) => Promise<{ decision: PendingDecision; revision: number } | undefined>
      serviceConnections?: ServiceConnections
      spaces?: () => { id: string; name: string; slug: string }[]
    },
  ) {}

  submit(event: PwaChatInput): ChatAcceptance {
    if (event.spaceId !== undefined && !this.options.hasSpace(event.spaceId))
      throw new Error('Unknown Chat Space')
    if (this.stopping) throw new Error('The Gateway is shutting down')
    const scope = scopeFor(event.spaceId)
    const acceptance = this.options.timeline.accept({
      submissionId: event.submissionId ?? randomUUID(),
      scope,
      text: event.text,
      ...(event.retryOf === undefined ? {} : { retryOf: event.retryOf }),
    })
    if (acceptance.state === 'accepted') {
      this.clients.set(acceptance.turnId, event.clientId)
      const entry = this.options.timeline.userEntry(acceptance.turnId)
      if (entry) this.options.publish(entry)
      this.schedule(scope)
    }
    return acceptance
  }

  recover(): void {
    for (const entry of this.options.timeline.recoverInterrupted()) {
      const user = this.options.timeline.userEntry(entry.turnId)
      if (user) this.options.publish(user)
      this.options.publish(entry)
    }
    for (const acceptance of this.options.timeline.accepted()) this.schedule(acceptance.scope)
    for (const waiting of this.options.timeline.waitingConnections()) {
      const attempt = this.options.serviceConnections?.attemptForTurn(waiting.turnId)
      if (!attempt) {
        this.finishWaiting(waiting.turnId, 'Connection setup could not be recovered.')
      } else if (attempt.continuation === 'claimed') {
        this.finishWaiting(
          waiting.turnId,
          'Interrupted. Connection work may have started. Choose Retry before running it again.',
          true,
        )
      } else if (
        attempt.state === 'ready' &&
        this.options.serviceConnections?.hasGrantForAttempt(attempt.id)
      ) {
        this.resumeConnection(attempt.id)
      } else if (['cancelled', 'unsupported'].includes(attempt.state)) {
        this.finishWaiting(waiting.turnId, attempt.reason ?? 'Connection setup did not finish.')
      } else {
        const entry = this.options.timeline.updateConnectionStatus(
          waiting.turnId,
          connectionStatus(attempt.review.service, attempt.state, attempt.reason),
        )
        if (entry) this.options.publish(entry)
      }
    }
  }

  resumeConnection(attemptId: string): void {
    const attempt = this.options.serviceConnections?.attempt(attemptId)
    if (!attempt || attempt.origin === 'management' || !attempt.turnId) return
    if (attempt.state !== 'ready') {
      const entry = this.options.timeline.updateConnectionStatus(
        attempt.turnId,
        connectionStatus(attempt.review.service, attempt.state, attempt.reason),
      )
      if (entry) this.options.publish(entry)
      if (['cancelled', 'unsupported'].includes(attempt.state))
        this.finishWaiting(attempt.turnId, attempt.reason ?? 'Connection setup did not finish.')
      return
    }
    if (
      attempt.continuation !== 'unclaimed' ||
      !this.options.serviceConnections?.hasGrantForAttempt(attempt.id)
    )
      return
    const user = this.options.timeline.resumeConnection(attempt.turnId)
    if (!user) return
    this.options.publish(user)
    const status = this.options.timeline.updateConnectionStatus(
      attempt.turnId,
      `${attempt.review.service === 'github' ? 'GitHub' : 'Gmail'} connection granted. Resuming the original request.`,
    )
    if (status) this.options.publish(status)
    this.schedule(user.scope)
  }

  receive(frame: GatewayServerMessage): void {
    if (!('turnId' in frame) || !this.clients.has(frame.turnId)) return
    if (frame.type === 'chat.turn-replace' || frame.type === 'chat.turn-end') {
      for (const decision of frame.message.pendingDecisions ?? []) {
        const entry = this.options.timeline.addDecision(frame.turnId, decision)
        if (entry) this.options.publish(entry)
        if (this.options.refreshDecision)
          void this.options
            .refreshDecision(decision.id)
            .then((current) => {
              if (!current) return
              const updated = this.options.timeline.updateDecision(
                decision.id,
                current.revision,
                current.decision,
              )
              if (updated) this.options.publish(updated)
            })
            .catch((error) => console.error('Chat decision reconciliation failed', error))
      }
      for (const decisionId of frame.message.pendingDecisionIds ?? []) {
        const entry = this.options.timeline.addUnprojectedDecision(frame.turnId, decisionId)
        if (entry) this.options.publish(entry)
        if (this.options.refreshDecision)
          void this.options
            .refreshDecision(decisionId)
            .then((current) => {
              if (!current) return
              const updated = this.options.timeline.updateDecision(
                decisionId,
                current.revision,
                current.decision,
              )
              if (updated) this.options.publish(updated)
            })
            .catch((error) => console.error('Chat decision reconciliation failed', error))
      }
    }
    if (frame.type === 'chat.turn-end' || frame.type === 'chat.turn-error') {
      const terminal =
        frame.type === 'chat.turn-end'
          ? (frame.message.pendingDecisions?.length || frame.message.pendingDecisionIds?.length) &&
            !frame.message.targets?.length
            ? this.options.timeline.completeWithDecisions(frame.turnId)
            : this.options.timeline.complete(frame.turnId, frame.message)
          : this.options.timeline.fail(frame.turnId, frame.error, this.stopping)
      if (terminal) {
        const user = this.options.timeline.userEntry(frame.turnId)
        if (user) this.options.publish(user)
        if (terminal.id !== user?.id) this.options.publish(terminal)
      }
    }
  }

  prepareStop(): void {
    this.stopping = true
  }

  subscribe(clientId: string, turnId: string): ChatScope | undefined {
    if (!this.clients.has(turnId) || this.stopping) return undefined
    const user = this.options.timeline.userEntry(turnId)
    if (!user || user.turnState !== 'running') return undefined
    if (user.scope.type === 'space' && !this.options.hasSpace(user.scope.spaceId)) return undefined
    let clients = this.subscribers.get(turnId)
    if (!clients) {
      clients = new Set()
      this.subscribers.set(turnId, clients)
    }
    clients.add(clientId)
    return user.scope
  }

  subscribersFor(turnId: string): string[] {
    return [...(this.subscribers.get(turnId) ?? [])]
  }

  async idle(): Promise<void> {
    await Promise.allSettled([...this.executing.values()])
  }

  private schedule(scope: ChatScope): void {
    if (this.stopping) return
    const key = scope.type === 'global' ? 'global' : `space:${scope.spaceId}`
    if (this.executing.has(key)) return
    const work = Promise.resolve().then(() => this.drain(scope))
    this.executing.set(key, work)
    void work.finally(() => {
      this.executing.delete(key)
      if (
        !this.stopping &&
        this.options.timeline.accepted().some((turn) => sameScope(turn.scope, scope))
      )
        this.schedule(scope)
    })
  }

  private async drain(scope: ChatScope): Promise<void> {
    while (!this.stopping) {
      const accepted = this.options.timeline.accepted().find((turn) => sameScope(turn.scope, scope))
      if (!accepted) return
      try {
        const userBeforeStart = this.options.timeline.userEntry(accepted.turnId)
        const requestText = userBeforeStart?.message.text ?? ''
        const serviceConnections = this.options.serviceConnections
        let attempt = serviceConnections?.attemptForTurn(accepted.turnId)
        if (serviceConnections && !attempt) {
          const intent = boundedServiceIntent(requestText)
          if (intent) {
            const targetSpaceId = targetSpaceForServiceRequest(
              requestText,
              scope.type === 'space' ? scope.spaceId : undefined,
              this.options.spaces?.() ?? [],
            )
            if (!targetSpaceId) {
              const result = this.options.timeline.complete(accepted.turnId, {
                role: 'assistant',
                text: 'Which Space should own this service request? Name one Space before connecting.',
              })
              if (result) {
                const user = this.options.timeline.userEntry(accepted.turnId)
                if (user) this.options.publish(user)
                this.options.publish(result)
              }
              continue
            }
            const eligible = serviceConnections.eligible({
              spaceId: targetSpaceId,
              service: intent.review.service,
              action: intent.review.actions[0]!,
              ...(intent.review.repository ? { repository: intent.review.repository } : {}),
            })
            if (!eligible) {
              attempt = serviceConnections.createAttempt({
                submissionId: accepted.submissionId,
                turnId: accepted.turnId,
                spaceId: targetSpaceId,
                requestSummary: intent.requestSummary,
                review: intent.review,
              })
              const entry = this.options.timeline.waitForConnection(
                accepted.turnId,
                attempt.id,
                connectionStatus(attempt.review.service, attempt.state),
              )
              const user = this.options.timeline.userEntry(accepted.turnId)
              if (user) this.options.publish(user)
              if (entry) this.options.publish(entry)
              continue
            }
          }
        }
        if (attempt && !serviceConnections?.claimContinuation(attempt.id)) {
          const entry = this.options.timeline.waitForConnection(
            accepted.turnId,
            attempt.id,
            connectionStatus(attempt.review.service, attempt.state, attempt.reason),
          )
          const user = this.options.timeline.userEntry(accepted.turnId)
          if (user) this.options.publish(user)
          if (entry) this.options.publish(entry)
          continue
        }
        if (!this.options.timeline.begin(accepted.turnId)) continue
        const user = this.options.timeline.userEntry(accepted.turnId)
        if (user) this.options.publish(user)
        this.clients.set(
          accepted.turnId,
          this.clients.get(accepted.turnId) ?? `recovered:${accepted.turnId}`,
        )
        try {
          await this.options.runTurn({
            clientId: this.clients.get(accepted.turnId)!,
            turnId: accepted.turnId,
            text: user?.message.text ?? '',
            receivedAt: user?.createdAt ?? new Date().toISOString(),
            ...(scope.type === 'space' ? { spaceId: scope.spaceId } : {}),
          })
          const current = this.options.timeline.userEntry(accepted.turnId)
          if (current?.turnState === 'running') this.finishMissing(accepted.turnId)
        } catch {
          this.finishMissing(accepted.turnId)
        } finally {
          if (attempt) serviceConnections?.completeContinuation(attempt.id)
          this.clients.delete(accepted.turnId)
          this.subscribers.delete(accepted.turnId)
        }
      } catch {
        this.finishMissing(accepted.turnId, 'The service request could not start on this Gateway.')
      }
    }
  }

  private finishWaiting(turnId: string, reason: string, interrupted = false): void {
    const entry = this.options.timeline.fail(turnId, reason, interrupted)
    if (!entry) return
    const user = this.options.timeline.userEntry(turnId)
    if (user) this.options.publish(user)
    this.options.publish(entry)
  }

  private finishMissing(turnId: string, reason?: string): void {
    const entry = this.options.timeline.fail(
      turnId,
      reason ??
        (this.stopping
          ? 'Interrupted. Completion is unknown. Choose Retry to run this request again.'
          : 'The Agent turn ended without a terminal result.'),
      this.stopping,
    )
    if (!entry) return
    const user = this.options.timeline.userEntry(turnId)
    if (user) this.options.publish(user)
    this.options.publish(entry)
  }
}

function connectionStatus(service: 'gmail' | 'github', state: string, reason?: string): string {
  const name = service === 'github' ? 'GitHub' : 'Gmail'
  if (state === 'reviewing')
    return `Review ${name} access in Service connections to continue this request.`
  if (state === 'authorizing') return `${name} authorization is in progress.`
  if (state === 'verifying') return `Verifying the reviewed ${name} capability.`
  if (state === 'needs_reconnect') return `${name} needs reconnection. ${reason ?? ''}`.trim()
  return reason ?? `${name} connection setup did not finish.`
}

function scopeFor(spaceId: string | undefined): ChatScope {
  return spaceId === undefined ? { type: 'global' } : { type: 'space', spaceId }
}

function sameScope(left: ChatScope, right: ChatScope): boolean {
  return (
    left.type === right.type &&
    (left.type === 'global' || left.spaceId === (right as { spaceId: string }).spaceId)
  )
}
