import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  ConnectionAttemptSchema,
  ConnectionReviewSchema,
  ServiceConnectionSchema,
  ServiceConnectionsSnapshotSchema,
  SpaceCapabilityGrantSchema,
  GithubRepositoryScopeSchema,
  type GithubRepositoryScope,
  type ConnectionAttempt,
  type ConnectionReview,
  type ServiceConnection,
  type ServiceConnectionsSnapshot,
  type ServiceKind,
  type SpaceCapabilityGrant,
} from '@veduta/protocol'
import { z } from 'zod'
import { backupFile, writeJsonAtomic } from './config-backup.ts'
import { readJsonFile } from './json-file.ts'

const FILE_NAME = 'service-connections.json'
const PendingGrantEvent = z
  .object({ id: z.string().uuid(), spaceId: z.string().min(1), summary: z.string().max(400) })
  .strict()
const StoredConnection = ServiceConnectionSchema.extend({
  credentialRef: z
    .string()
    .regex(/^secret:\/\/vault\/[A-Za-z0-9_-]+$/)
    .optional(),
}).strict()
const FileSchema = z
  .object({
    version: z.literal(1),
    attempts: z.array(ConnectionAttemptSchema),
    connections: z.array(StoredConnection),
    grants: z.array(SpaceCapabilityGrantSchema),
    pendingEvents: z.array(PendingGrantEvent).default([]),
  })
  .strict()
type StoredServiceConnection = z.infer<typeof StoredConnection>

export class ServiceConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function githubRepositoryAllowed(
  grant: SpaceCapabilityGrant,
  repository: { owner: string; name: string },
): boolean {
  if (grant.repositoryScope?.mode === 'authorized') return true
  const repositories =
    grant.repositoryScope?.mode === 'selected'
      ? grant.repositoryScope.repositories
      : grant.repository
        ? [grant.repository]
        : []
  return repositories.some(
    (item) =>
      item.owner.toLowerCase() === repository.owner.toLowerCase() &&
      item.name.toLowerCase() === repository.name.toLowerCase(),
  )
}

/** Gateway-owned non-secret attempt, connection and Space-grant authority. */
export class ServiceConnections {
  private readonly path: string
  private readonly now: () => Date
  private attempts: ConnectionAttempt[]
  private connections: StoredServiceConnection[]
  private grants: SpaceCapabilityGrant[]
  private pendingEvents: z.infer<typeof PendingGrantEvent>[]
  private readonly listeners = new Set<() => void>()

  constructor(
    rootDir: string,
    options: {
      now?: () => Date
      onGrantChanged?: (spaceId: string, summary: string, eventId?: string) => void
      onCredentialRemoved?: (ref: string) => void
    } = {},
  ) {
    this.path = join(rootDir, FILE_NAME)
    this.now = options.now ?? (() => new Date())
    this.onGrantChanged = options.onGrantChanged
    this.onCredentialRemoved = options.onCredentialRemoved
    const stored = existsSync(this.path)
      ? FileSchema.parse(readJsonFile(this.path, { description: 'Service connections' }))
      : FileSchema.parse({ version: 1, attempts: [], connections: [], grants: [] })
    this.attempts = stored.attempts
    this.connections = stored.connections
    this.grants = stored.grants
    this.pendingEvents = stored.pendingEvents
    this.recover()
    this.flushPendingEvents()
  }

  private readonly onGrantChanged:
    ((spaceId: string, summary: string, eventId?: string) => void) | undefined
  private readonly onCredentialRemoved: ((ref: string) => void) | undefined

  snapshot(): ServiceConnectionsSnapshot {
    this.flushPendingEvents()
    return ServiceConnectionsSnapshotSchema.parse({
      attempts: this.attempts,
      connections: this.connections.map(({ credentialRef: _credentialRef, ...connection }) =>
        ServiceConnectionSchema.parse(connection),
      ),
      grants: this.grants,
    })
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attempt(id: string): ConnectionAttempt | undefined {
    return this.attempts.find((item) => item.id === id)
  }

  attemptForTurn(turnId: string): ConnectionAttempt | undefined {
    return this.attempts.find((item) => item.turnId === turnId)
  }

  createAttempt(input: {
    submissionId: string
    origin?: 'chat' | 'management'
    turnId?: string
    spaceId?: string
    requestSummary: string
    review: ConnectionReview
    connectionId?: string
    renewAuthorization?: true
  }): ConnectionAttempt {
    const review = ConnectionReviewSchema.parse(input.review)
    const existing = this.attempts.find((attempt) => attempt.submissionId === input.submissionId)
    if (existing) {
      if (
        existing.origin !== (input.origin ?? 'chat') ||
        existing.turnId !== input.turnId ||
        existing.spaceId !== input.spaceId ||
        existing.renewAuthorization !== input.renewAuthorization ||
        existing.requestSummary !== input.requestSummary ||
        JSON.stringify(existing.review) !== JSON.stringify(review)
      )
        throw new ServiceConnectionError(409, 'Connection attempt identity was reused')
      return existing
    }
    if (input.turnId && this.attempts.some((attempt) => attempt.turnId === input.turnId))
      throw new ServiceConnectionError(409, 'Chat turn already has a Connection attempt')
    const at = this.now().toISOString()
    const attempt = ConnectionAttemptSchema.parse({
      id: randomUUID(),
      submissionId: input.submissionId,
      origin: input.origin ?? 'chat',
      turnId: input.turnId,
      spaceId: input.spaceId,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.renewAuthorization ? { renewAuthorization: true } : {}),
      requestSummary: input.requestSummary.trim().slice(0, 700),
      review,
      state: 'reviewing',
      continuation: 'unclaimed',
      createdAt: at,
      updatedAt: at,
    })
    this.attempts.push(attempt)
    this.persist()
    return attempt
  }

  beginAuthorization(id: string): ConnectionAttempt {
    const attempt = this.requiredAttempt(id)
    if (attempt.state !== 'reviewing' && attempt.state !== 'needs_reconnect')
      throw new ServiceConnectionError(409, 'Connection attempt is not ready for authorization')
    attempt.state = 'authorizing'
    delete attempt.reason
    delete attempt.nextAction
    attempt.updatedAt = this.now().toISOString()
    this.persist()
    return attempt
  }

  attachConnection(id: string, connectionId: string): void {
    const attempt = this.requiredAttempt(id)
    if (attempt.state !== 'authorizing')
      throw new ServiceConnectionError(409, 'Connection attempt is not authorizing')
    if (attempt.connectionId && attempt.connectionId !== connectionId)
      throw new ServiceConnectionError(409, 'Connection attempt already uses another account')
    attempt.connectionId = connectionId
    attempt.updatedAt = this.now().toISOString()
    this.persist()
  }

  retryReview(id: string): ConnectionAttempt {
    const attempt = this.requiredAttempt(id)
    if (!['failed', 'unsupported', 'needs_reconnect'].includes(attempt.state))
      throw new ServiceConnectionError(409, 'Connection attempt cannot return to review')
    if (attempt.continuation !== 'unclaimed')
      throw new ServiceConnectionError(409, 'Connection task has already resumed')
    attempt.state = 'reviewing'
    delete attempt.reason
    delete attempt.nextAction
    delete attempt.verifiedAccount
    delete attempt.verifiedScopes
    if (
      !attempt.renewAuthorization &&
      !this.connections.some(
        (connection) => connection.id === attempt.connectionId && connection.state !== 'removed',
      )
    )
      delete attempt.connectionId
    attempt.updatedAt = this.now().toISOString()
    this.persist()
    return attempt
  }

  beginVerification(id: string): ConnectionAttempt {
    const attempt = this.requiredAttempt(id)
    if (attempt.state !== 'authorizing')
      throw new ServiceConnectionError(409, 'Connection attempt is not authorizing')
    attempt.state = 'verifying'
    attempt.updatedAt = this.now().toISOString()
    this.persist()
    return attempt
  }

  verified(
    id: string,
    input: {
      connectionId: string
      account: string
      scopes: string[]
      mechanism: 'gmail-oauth' | 'github-mcp-stdio'
      credentialRef?: string
      rotateAuthorization?: boolean
    },
  ): ConnectionAttempt {
    const attempt = this.requiredAttempt(id)
    if (attempt.state !== 'verifying')
      throw new ServiceConnectionError(409, 'Connection attempt is not verifying')
    if (
      input.scopes.length !== attempt.review.scopes.length ||
      input.scopes.some((scope) => !attempt.review.scopes.includes(scope))
    ) {
      this.returnToReview(attempt, 'Provider scopes changed; review them again')
      throw new ServiceConnectionError(409, 'Provider scopes changed; review them again')
    }
    if (
      attempt.review.accountHint &&
      attempt.review.accountHint.toLowerCase() !== input.account.toLowerCase()
    ) {
      this.returnToReview(attempt, 'Verified account differs from the reviewed account hint')
      throw new ServiceConnectionError(
        409,
        'Verified account differs from the reviewed account hint',
      )
    }
    const at = this.now().toISOString()
    const revokedSpaces = new Set<string>()
    let previousCredentialRef: string | undefined
    let connection = this.connections.find((item) => item.id === input.connectionId)
    if (connection && connection.account.toLowerCase() !== input.account.toLowerCase()) {
      this.returnToReview(attempt, 'Connection account changed; review it again')
      throw new ServiceConnectionError(409, 'Connection account changed; review it again')
    }
    if (connection) {
      const authorizationChanged =
        connection.state !== 'ready' ||
        input.rotateAuthorization === true ||
        (input.credentialRef !== undefined && input.credentialRef !== connection.credentialRef) ||
        JSON.stringify([...connection.scopes].sort()) !== JSON.stringify([...input.scopes].sort())
      if (authorizationChanged) {
        for (const grant of this.grants) {
          if (grant.connectionId === connection.id && grant.enabled) {
            grant.enabled = false
            grant.updatedAt = at
            revokedSpaces.add(grant.spaceId)
          }
        }
        connection.authorizationRevision = randomUUID()
      }
      connection.state = 'ready'
      connection.scopes = input.scopes
      connection.updatedAt = at
      if (input.credentialRef) {
        previousCredentialRef = connection.credentialRef
        connection.credentialRef = input.credentialRef
      }
      delete connection.reason
    } else {
      connection = StoredConnection.parse({
        id: input.connectionId,
        service: attempt.review.service,
        mechanism: input.mechanism,
        account: input.account,
        scopes: input.scopes,
        executionHost: attempt.review.executionHost,
        authorizationRevision: randomUUID(),
        state: 'ready',
        ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
        createdAt: at,
        updatedAt: at,
      })
      this.connections.push(connection)
    }
    attempt.connectionId = connection.id
    attempt.verifiedAccount = connection.account
    attempt.verifiedScopes = [...connection.scopes]
    attempt.state = 'ready'
    attempt.updatedAt = at
    for (const spaceId of revokedSpaces)
      this.pendingEvents.push({
        id: randomUUID(),
        spaceId,
        summary: 'Service authorization changed; review Space access again',
      })
    this.persist()
    if (previousCredentialRef && previousCredentialRef !== input.credentialRef) {
      try {
        this.onCredentialRemoved?.(previousCredentialRef)
      } catch {
        console.warn('Previous service credential cleanup failed')
      }
    }
    return attempt
  }

  grant(
    id: string,
    confirmedAccount: string,
    confirmedScopes: string[],
    targetSpaceId?: string,
    requestedRepositoryScope?: GithubRepositoryScope,
  ): SpaceCapabilityGrant {
    const attempt = this.requiredAttempt(id)
    const spaceId = attempt.origin === 'management' ? targetSpaceId : attempt.spaceId
    if (
      !spaceId ||
      (attempt.origin === 'chat' && targetSpaceId && targetSpaceId !== attempt.spaceId)
    )
      throw new ServiceConnectionError(400, 'Confirm the correct Space for this attempt')
    this.flushPendingEvents()
    if (this.pendingEvents.some((event) => event.spaceId === spaceId))
      throw new ServiceConnectionError(
        503,
        'Space access is waiting for its Event log. Retry when Gateway storage is available.',
      )
    const connection = this.confirmVerifiedAccount(id, confirmedAccount, confirmedScopes)
    if (requestedRepositoryScope && !attempt.review.repositoryScope)
      throw new ServiceConnectionError(
        400,
        'This legacy grant requires a protected read-profile upgrade',
      )
    const repositoryScope = requestedRepositoryScope
      ? GithubRepositoryScopeSchema.parse(requestedRepositoryScope)
      : attempt.review.repositoryScope
    const existing = this.grants.find(
      (grant) =>
        grant.spaceId === spaceId &&
        grant.connectionId === connection.id &&
        grant.authorizationRevision === connection.authorizationRevision &&
        grant.enabled &&
        JSON.stringify(grant.repository) === JSON.stringify(attempt.review.repository) &&
        JSON.stringify(grant.repositoryScope) === JSON.stringify(repositoryScope) &&
        JSON.stringify(grant.actions) === JSON.stringify(attempt.review.actions),
    )
    if (existing) return existing
    const at = this.now().toISOString()
    const grant = SpaceCapabilityGrantSchema.parse({
      id: randomUUID(),
      spaceId,
      connectionId: connection.id,
      authorizationRevision: connection.authorizationRevision,
      actions: attempt.review.actions,
      ...(repositoryScope ? { repositoryScope } : {}),
      ...(attempt.review.repository ? { repository: attempt.review.repository } : {}),
      enabled: true,
      createdAt: at,
      updatedAt: at,
    })
    if (repositoryScope) {
      for (const prior of this.grants) {
        if (
          prior.spaceId === spaceId &&
          prior.connectionId === connection.id &&
          prior.repositoryScope &&
          prior.enabled
        ) {
          prior.enabled = false
          prior.updatedAt = at
        }
      }
    }
    this.grants.push(grant)
    this.persist()
    this.onGrantChanged?.(grant.spaceId, `${connection.service} capability granted`)
    return grant
  }

  confirmVerifiedAccount(
    id: string,
    confirmedAccount: string,
    confirmedScopes: string[],
  ): ServiceConnection {
    const attempt = this.requiredAttempt(id)
    if (attempt.state !== 'ready' || !attempt.connectionId || !attempt.verifiedAccount)
      throw new ServiceConnectionError(409, 'Connection attempt is not verified')
    const connection = this.requiredConnection(attempt.connectionId)
    if (
      connection.state !== 'ready' ||
      connection.account !== confirmedAccount ||
      attempt.verifiedAccount !== confirmedAccount ||
      JSON.stringify([...connection.scopes].sort()) !==
        JSON.stringify([...confirmedScopes].sort()) ||
      JSON.stringify([...attempt.verifiedScopes!].sort()) !==
        JSON.stringify([...confirmedScopes].sort())
    )
      throw new ServiceConnectionError(
        409,
        'Account or scopes changed; review the connection again',
      )
    return connection
  }

  claimContinuation(id: string): boolean {
    const attempt = this.requiredAttempt(id)
    if (attempt.origin === 'management') return false
    if (attempt.state !== 'ready' || attempt.continuation !== 'unclaimed') return false
    if (!this.grantForAttempt(attempt)) return false
    attempt.continuation = 'claimed'
    attempt.updatedAt = this.now().toISOString()
    this.persist()
    return true
  }

  hasGrantForAttempt(id: string): boolean {
    return Boolean(this.grantForAttempt(this.requiredAttempt(id)))
  }

  completeContinuation(id: string): void {
    const attempt = this.requiredAttempt(id)
    if (attempt.continuation !== 'claimed') return
    attempt.continuation = 'completed'
    attempt.updatedAt = this.now().toISOString()
    this.persist()
  }

  eligible(input: {
    spaceId: string
    service: ServiceKind
    action: string
    connectionId?: string
    accountHint?: string
    repository?: { owner: string; name: string }
  }):
    | { connection: ServiceConnection; grant: SpaceCapabilityGrant; credentialRef?: string }
    | undefined {
    for (const grant of this.grants) {
      if (
        grant.spaceId !== input.spaceId ||
        !grant.enabled ||
        !grant.actions.includes(input.action)
      )
        continue
      if (input.connectionId && grant.connectionId !== input.connectionId) continue
      if (input.service === 'github') {
        if (input.repository && !githubRepositoryAllowed(grant, input.repository)) continue
        if (!input.repository && (input.action !== 'list_repositories' || !grant.repositoryScope))
          continue
      } else if (JSON.stringify(grant.repository) !== JSON.stringify(input.repository)) continue
      const connection = this.connections.find((candidate) => candidate.id === grant.connectionId)
      if (
        !connection ||
        connection.service !== input.service ||
        (input.accountHint !== undefined &&
          connection.account.toLowerCase() !== input.accountHint.toLowerCase()) ||
        connection.state !== 'ready' ||
        connection.authorizationRevision !== grant.authorizationRevision
      )
        continue
      const { credentialRef, ...publicConnection } = connection
      return {
        connection: ServiceConnectionSchema.parse(publicConnection),
        grant,
        ...(credentialRef ? { credentialRef } : {}),
      }
    }
    return undefined
  }

  credentialRef(id: string): string | undefined {
    return this.requiredConnection(id).credentialRef
  }

  cancel(id: string): ConnectionAttempt {
    const attempt = this.requiredAttempt(id)
    if (attempt.continuation !== 'unclaimed')
      throw new ServiceConnectionError(409, 'Connection task has already resumed')
    if (attempt.state === 'cancelled') return attempt
    if (attempt.state === 'failed' || attempt.state === 'unsupported')
      throw new ServiceConnectionError(409, 'Connection attempt is already terminal')
    attempt.state = 'cancelled'
    attempt.reason = 'Connection setup was cancelled; the requested task was not run.'
    attempt.nextAction = 'Start a new Chat request when ready.'
    attempt.updatedAt = this.now().toISOString()
    this.persist()
    return attempt
  }

  fail(id: string, state: 'failed' | 'unsupported' | 'needs_reconnect', reason: string): void {
    const attempt = this.requiredAttempt(id)
    if (attempt.continuation !== 'unclaimed') return
    attempt.state = state
    attempt.reason = reason.slice(0, 400)
    attempt.nextAction =
      state === 'needs_reconnect' ? 'Reconnect the service.' : 'Review and retry.'
    attempt.updatedAt = this.now().toISOString()
    this.persist()
  }

  disableGrant(id: string): void {
    const grant = this.grants.find((item) => item.id === id)
    if (!grant) throw new ServiceConnectionError(404, 'Space capability grant not found')
    if (!grant.enabled) return
    grant.enabled = false
    grant.updatedAt = this.now().toISOString()
    this.persist()
    this.onGrantChanged?.(grant.spaceId, 'Service capability disabled')
  }

  disableConnection(id: string): void {
    const connection = this.requiredConnection(id)
    if (connection.state === 'disabled') return
    connection.state = 'disabled'
    connection.updatedAt = this.now().toISOString()
    this.persist()
    for (const grant of this.grants.filter((item) => item.connectionId === id && item.enabled))
      this.onGrantChanged?.(grant.spaceId, 'Service connection disabled')
  }

  recordReadFailure(
    id: string,
    authorizationRevision: string,
    state: 'needs_reconnect' | 'degraded',
    reason: string,
  ): void {
    const connection = this.requiredConnection(id)
    if (connection.state !== 'ready' || connection.authorizationRevision !== authorizationRevision)
      return
    connection.state = state
    connection.reason = reason.slice(0, 400)
    connection.updatedAt = this.now().toISOString()
    this.persist()
    for (const grant of this.grants.filter((item) => item.connectionId === id && item.enabled))
      this.onGrantChanged?.(grant.spaceId, `Service connection ${state}: ${connection.reason}`)
  }

  removeConnection(id: string): void {
    const connection = this.requiredConnection(id)
    if (connection.state === 'removed') return
    connection.state = 'removed'
    connection.updatedAt = this.now().toISOString()
    const credentialRef = connection.credentialRef
    delete connection.credentialRef
    this.persist()
    if (credentialRef) this.onCredentialRemoved?.(credentialRef)
    for (const grant of this.grants.filter((item) => item.connectionId === id && item.enabled))
      this.onGrantChanged?.(grant.spaceId, 'Service connection removed')
  }

  private grantForAttempt(attempt: ConnectionAttempt): SpaceCapabilityGrant | undefined {
    if (!attempt.connectionId || attempt.origin === 'management') return undefined
    const connection = this.connections.find((item) => item.id === attempt.connectionId)
    if (!connection || connection.state !== 'ready') return undefined
    return this.grants.find(
      (grant) =>
        grant.enabled &&
        grant.spaceId === attempt.spaceId &&
        grant.connectionId === connection.id &&
        grant.authorizationRevision === connection.authorizationRevision &&
        JSON.stringify(grant.repository) === JSON.stringify(attempt.review.repository) &&
        attempt.review.actions.every((action) => grant.actions.includes(action)),
    )
  }

  private returnToReview(attempt: ConnectionAttempt, reason: string): void {
    attempt.state = 'reviewing'
    attempt.reason = reason
    attempt.nextAction = 'Review the exact account and scopes again.'
    attempt.updatedAt = this.now().toISOString()
    this.persist()
  }

  private recover(): void {
    let changed = false
    for (const attempt of this.attempts) {
      if (attempt.state === 'authorizing' || attempt.state === 'verifying') {
        attempt.state = 'needs_reconnect'
        attempt.reason = 'Connection setup was interrupted; authorization must be repeated.'
        attempt.nextAction = 'Reconnect the service.'
        attempt.updatedAt = this.now().toISOString()
        changed = true
      }
    }
    if (changed) this.persist()
  }

  private requiredAttempt(id: string): ConnectionAttempt {
    const attempt = this.attempts.find((item) => item.id === id)
    if (!attempt) throw new ServiceConnectionError(404, 'Connection attempt not found')
    return attempt
  }

  private requiredConnection(id: string): StoredServiceConnection {
    const connection = this.connections.find((item) => item.id === id)
    if (!connection) throw new ServiceConnectionError(404, 'Service connection not found')
    return connection
  }

  private persist(): void {
    this.writeState()
    this.flushPendingEvents()
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        console.warn('Service connection change notification failed')
      }
    }
  }

  private flushPendingEvents(): void {
    if (!this.onGrantChanged) return
    while (this.pendingEvents.length > 0) {
      const event = this.pendingEvents[0]!
      try {
        this.onGrantChanged(event.spaceId, event.summary, event.id)
        this.pendingEvents.shift()
        this.writeState()
      } catch {
        if (!this.pendingEvents.some((item) => item.id === event.id))
          this.pendingEvents.unshift(event)
        console.warn('Service grant Event delivery is pending')
        return
      }
    }
  }

  private writeState(): void {
    const file = FileSchema.parse({
      version: 1,
      attempts: this.attempts,
      connections: this.connections,
      grants: this.grants,
      pendingEvents: this.pendingEvents,
    })
    backupFile(this.path)
    writeJsonAtomic(this.path, file)
  }
}
