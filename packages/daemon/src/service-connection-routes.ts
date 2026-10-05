import {
  CreateGmailConnectionRequestSchema,
  CreateServiceConnectionAttemptRequestSchema,
  ServiceConnectionsSnapshotSchema,
  GrantServiceConnectionRequestSchema,
  type ServiceConnectionsSnapshot,
} from '@veduta/protocol'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { GmailConnectionError, type GmailConnections } from './gmail-connections.ts'
import type { GithubMcpService } from './github-mcp-service.ts'
import { rejectUnexpectedBody } from './fastify-validation.ts'
import { ServiceConnectionError, type ServiceConnections } from './service-connections.ts'
import type { ChatTimelineCoordinator } from './chat-timeline-coordinator.ts'
import { githubConnectionReview, githubReadConnectionReview } from './github-mcp-service.ts'
import { gmailConnectionReview } from './service-intent.ts'

const GithubToken = z
  .object({
    token: z
      .string()
      .regex(/^github_pat_[A-Za-z0-9_]{20,}$/)
      .max(300),
  })
  .strict()
const GmailStart = z
  .object({
    redirectOrigin: z.string().url(),
    gmailConnectionId: z.string().optional(),
    name: z.string().min(1).max(120).optional(),
    clientId: z.string().min(1).max(500).optional(),
    clientSecret: z.string().min(1).max(500).optional(),
  })
  .strict()
const GmailCallback = z
  .object({
    code: z.string().min(1).max(4096).optional(),
    state: z.string().min(1).max(512),
    error: z.string().max(100).optional(),
  })
  .strict()

async function guarded<T>(
  reply: FastifyReply,
  run: () => T | Promise<T>,
  onError?: () => void,
): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    onError?.()
    if (error instanceof ServiceConnectionError || error instanceof GmailConnectionError)
      reply.status(error.status).send({ error: error.message })
    else reply.status(500).send({ error: 'Service connection request failed' })
    return undefined
  }
}

export function registerServiceConnectionRoutes(
  app: FastifyInstance,
  options: {
    connections: ServiceConnections
    gmail: GmailConnections
    github: GithubMcpService
    coordinator: ChatTimelineCoordinator
    hasSpace: (id: string) => boolean
  },
): void {
  const snapshot = (): ServiceConnectionsSnapshot =>
    ServiceConnectionsSnapshotSchema.parse(options.connections.snapshot())

  app.get('/api/service-connections', snapshot)

  app.post('/api/service-connections/attempts', (request, reply) => {
    const parsed = CreateServiceConnectionAttemptRequestSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid connection setup request' })
    return guarded(reply, () => {
      const input = parsed.data
      const connection = input.connectionId
        ? snapshot().connections.find(
            (item) =>
              item.id === input.connectionId &&
              item.service === input.service &&
              item.state !== 'removed',
          )
        : undefined
      const nativeGmail =
        input.service === 'gmail' && input.connectionId
          ? options.gmail.snapshot().connections.find((item) => item.id === input.connectionId)
          : undefined
      if (input.connectionId && !connection && !nativeGmail)
        throw new ServiceConnectionError(404, 'Service connection not found')
      const account = connection?.account ?? nativeGmail?.accountEmail
      const review =
        input.service === 'github'
          ? input.repository
            ? githubConnectionReview(
                input.repository!.owner,
                input.repository!.name,
                account,
                connection?.scopes.includes(
                  `GitHub Issues: write in ${input.repository!.owner}/${input.repository!.name}`,
                )
                  ? 'write'
                  : 'read',
              )
            : githubReadConnectionReview(account)
          : gmailConnectionReview(account)
      options.connections.createAttempt({
        submissionId: input.submissionId,
        origin: 'management',
        requestSummary: account
          ? `Review access for ${account}`
          : `Connect ${input.service === 'github' ? 'GitHub' : 'Gmail'}`,
        review,
        ...(input.connectionId ? { connectionId: input.connectionId } : {}),
        ...(input.renewAuthorization ? { renewAuthorization: true } : {}),
      })
      return snapshot()
    })
  })

  app.post('/api/service-connections/attempts/:id/use-connection', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      const attempt = options.connections.attempt(id)
      const connection = snapshot().connections.find((item) => item.id === attempt?.connectionId)
      if (
        !attempt ||
        attempt.origin !== 'management' ||
        attempt.renewAuthorization ||
        connection?.state !== 'ready'
      )
        throw new ServiceConnectionError(409, 'A verified connection is required')
      options.connections.beginAuthorization(id)
      options.connections.beginVerification(id)
      options.connections.verified(id, {
        connectionId: connection.id,
        account: connection.account,
        scopes: connection.scopes,
        mechanism: connection.mechanism,
      })
      return snapshot()
    })
  })

  app.post('/api/service-connections/attempts/:id/github/authorize', (request, reply) => {
    const parsed = GithubToken.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid GitHub token request' })
    const { id } = request.params as { id: string }
    return guarded(reply, async () => {
      options.connections.beginAuthorization(id)
      try {
        await options.github.verifyAttempt(id, parsed.data.token)
      } catch (error) {
        options.coordinator.resumeConnection(id)
        throw error
      }
      return snapshot()
    })
  })

  app.post('/api/service-connections/attempts/:id/gmail/authorize', (request, reply) => {
    const parsed = GmailStart.safeParse(request.body)
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid Gmail authorization request' })
    const { id } = request.params as { id: string }
    return guarded(
      reply,
      async () => {
        const attempt = options.connections.attempt(id)
        if (!attempt || attempt.review.service !== 'gmail')
          throw new ServiceConnectionError(404, 'Gmail Connection attempt not found')
        if (attempt.connectionId && parsed.data.gmailConnectionId !== attempt.connectionId)
          throw new ServiceConnectionError(
            409,
            'This setup already uses an account. Cancel it to connect another account.',
          )
        if (
          parsed.data.gmailConnectionId &&
          snapshot().attempts.some(
            (item) => item.id !== id && item.createdConnectionId === parsed.data.gmailConnectionId,
          ) &&
          !snapshot().connections.some(
            (item) => item.id === parsed.data.gmailConnectionId && item.state !== 'removed',
          )
        )
          throw new ServiceConnectionError(
            409,
            'Finish the original setup before reusing this account',
          )
        const newConnection =
          parsed.data.gmailConnectionId === undefined
            ? CreateGmailConnectionRequestSchema.safeParse({
                name: parsed.data.name,
                ...(parsed.data.clientId === undefined ? {} : { clientId: parsed.data.clientId }),
                ...(parsed.data.clientSecret === undefined
                  ? {}
                  : { clientSecret: parsed.data.clientSecret }),
              })
            : undefined
        if (newConnection && !newConnection.success)
          throw new ServiceConnectionError(400, 'Gmail OAuth client credentials are required')
        if (
          newConnection?.success &&
          !('clientId' in newConnection.data) &&
          !options.gmail.snapshot().oauthClient?.configured
        )
          throw new ServiceConnectionError(
            409,
            'Set up Google OAuth before connecting a Gmail account',
          )
        if (
          parsed.data.gmailConnectionId &&
          snapshot().attempts.some(
            (item) =>
              item.id !== id &&
              item.connectionId === parsed.data.gmailConnectionId &&
              ['authorizing', 'verifying'].includes(item.state),
          )
        )
          throw new ServiceConnectionError(
            409,
            'This Gmail account already has an authorization in progress',
          )
        options.connections.beginAuthorization(id)
        const gmailConnectionId =
          parsed.data.gmailConnectionId ??
          options.gmail.create(newConnection!.data).connections.at(-1)?.id
        if (!gmailConnectionId)
          throw new ServiceConnectionError(409, 'Gmail connection could not be prepared')
        options.connections.attachConnection(id, gmailConnectionId, !parsed.data.gmailConnectionId)
        const existing = options.gmail
          .snapshot()
          .connections.find((connection) => connection.id === gmailConnectionId)
        if (!existing) throw new ServiceConnectionError(404, 'Gmail connection not found')
        if (existing.state === 'ready' && existing.accountEmail && !attempt.renewAuthorization) {
          options.connections.beginVerification(id)
          const verified = await options.gmail.verifyAccount(gmailConnectionId)
          options.connections.verified(id, {
            connectionId: gmailConnectionId,
            account: verified,
            scopes: existing.scopes,
            mechanism: 'gmail-oauth',
          })
          return { snapshot: snapshot() }
        }
        const authorization = options.gmail.beginAuthorization(
          gmailConnectionId,
          parsed.data.redirectOrigin,
          '/app/connections',
        )
        return { snapshot: snapshot(), authorizationUrl: authorization.authorizationUrl }
      },
      () => {
        const attempt = options.connections.attempt(id)
        if (attempt && ['authorizing', 'verifying'].includes(attempt.state))
          options.connections.fail(
            id,
            'failed',
            'Gmail authorization did not finish. Return to review and try again.',
          )
        options.coordinator.resumeConnection(id)
      },
    )
  })

  app.post('/api/service-connections/gmail/callback', (request, reply) => {
    const parsed = GmailCallback.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid Gmail callback' })
    return guarded(reply, async () => {
      const gmailId = parsed.data.state.split('.')[0]
      const attempts = options.connections
        .snapshot()
        .attempts.filter((item) => item.review.service === 'gmail' && item.connectionId === gmailId)
      const attempt =
        attempts.find((item) => ['authorizing', 'verifying'].includes(item.state)) ??
        attempts.at(-1)
      if (!gmailId || !attempt)
        throw new ServiceConnectionError(409, 'Gmail callback has no attempt')
      if (attempt.state === 'ready') return snapshot()
      if (!['authorizing', 'verifying'].includes(attempt.state))
        throw new ServiceConnectionError(409, 'Gmail authorization is no longer in progress')
      options.gmail.assertAuthorizationState(gmailId, parsed.data.state)
      if (parsed.data.error) {
        options.gmail.failAuthorization(
          gmailId,
          parsed.data.state,
          parsed.data.error === 'access_denied' ? 'access_denied' : 'other',
        )
        options.connections.fail(attempt.id, 'failed', 'Gmail authorization was declined.')
        options.coordinator.resumeConnection(attempt.id)
        return snapshot()
      }
      if (!parsed.data.code) throw new ServiceConnectionError(400, 'Gmail code is missing')
      options.connections.beginVerification(attempt.id)
      try {
        const gmail = await options.gmail.completeAuthorization(
          gmailId,
          parsed.data.code,
          parsed.data.state,
        )
        const connection = gmail.connections.find((item) => item.id === gmailId)
        if (!connection?.accountEmail || connection.state !== 'ready')
          throw new ServiceConnectionError(409, 'Gmail account did not verify')
        options.connections.verified(attempt.id, {
          connectionId: gmailId,
          account: connection.accountEmail,
          scopes: connection.scopes,
          mechanism: 'gmail-oauth',
          rotateAuthorization: true,
        })
      } catch (error) {
        if (options.connections.attempt(attempt.id)?.state === 'verifying')
          options.connections.fail(
            attempt.id,
            'failed',
            error instanceof GmailConnectionError
              ? error.message
              : 'Gmail verification failed; reconnect.',
          )
        options.coordinator.resumeConnection(attempt.id)
        throw error
      }
      return snapshot()
    })
  })

  app.post('/api/service-connections/attempts/:id/grant', (request, reply) => {
    const parsed = GrantServiceConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid Space grant confirmation' })
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      const attempt = options.connections.attempt(id)
      if (!attempt) throw new ServiceConnectionError(404, 'Connection attempt not found')
      if (
        parsed.data.repositoryScopes &&
        (!attempt.review.repositoryScope ||
          Object.keys(parsed.data.repositoryScopes).some(
            (spaceId) => !(parsed.data.spaceIds ?? [attempt.spaceId]).includes(spaceId),
          ))
      )
        throw new ServiceConnectionError(
          400,
          'Repository restrictions must belong to the reviewed Spaces and read profile',
        )
      if (attempt.origin === 'management') {
        if (!parsed.data.spaceIds)
          throw new ServiceConnectionError(400, 'Confirm the selected Spaces')
        if (parsed.data.spaceIds.some((spaceId) => !options.hasSpace(spaceId)))
          throw new ServiceConnectionError(404, 'Space not found')
        options.connections.confirmVerifiedAccount(id, parsed.data.account, parsed.data.scopes)
        for (const spaceId of new Set(parsed.data.spaceIds))
          options.connections.grant(
            id,
            parsed.data.account,
            parsed.data.scopes,
            spaceId,
            parsed.data.repositoryScopes?.[spaceId],
          )
      } else {
        if (parsed.data.spaceIds)
          throw new ServiceConnectionError(400, 'Chat setup grants only its original Space')
        options.connections.grant(
          id,
          parsed.data.account,
          parsed.data.scopes,
          undefined,
          parsed.data.repositoryScopes?.[attempt.spaceId!],
        )
      }
      options.coordinator.resumeConnection(id)
      return snapshot()
    })
  })

  app.post('/api/service-connections/attempts/:id/cancel', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      const attempt = options.connections.cancel(id)
      if (
        attempt.review.service === 'gmail' &&
        attempt.createdConnectionId &&
        !snapshot().connections.some((item) => item.id === attempt.createdConnectionId) &&
        options.gmail.snapshot().connections.some((item) => item.id === attempt.createdConnectionId)
      )
        options.gmail.remove(attempt.createdConnectionId)
      options.coordinator.resumeConnection(id)
      return snapshot()
    })
  })

  app.post('/api/service-connections/attempts/:id/retry', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      options.connections.retryReview(id)
      options.coordinator.resumeConnection(id)
      return snapshot()
    })
  })

  app.post('/api/service-connections/grants/:id/disable', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      options.connections.disableGrant(id)
      return snapshot()
    })
  })

  app.post('/api/service-connections/:id/disable', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      options.connections.disableConnection(id)
      return snapshot()
    })
  })

  app.delete('/api/service-connections/:id', (request, reply) => {
    const { id } = request.params as { id: string }
    return guarded(reply, () => {
      const connection = options.connections.snapshot().connections.find((item) => item.id === id)
      if (connection?.service === 'gmail') options.gmail.remove(id)
      options.connections.removeConnection(id)
      return snapshot()
    })
  })
}
