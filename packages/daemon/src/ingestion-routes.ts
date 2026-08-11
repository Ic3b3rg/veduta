import type { FastifyInstance } from 'fastify'
import type { ProgressiveAuthLockout } from './auth-rate-limit.ts'
import type { EventIngestion } from './event-ingestion.ts'

/** Registers the raw-body webhook scope used for source signature verification. */
export function registerIngestionRoutes(
  app: FastifyInstance,
  deps: { ingestion: EventIngestion; lockout: ProgressiveAuthLockout },
): void {
  const { ingestion, lockout } = deps
  void app.register(async (instance) => {
    instance.removeAllContentTypeParsers()
    instance.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body)
    })
    instance.post('/api/ingest/:source', { bodyLimit: 256 * 1024 }, async (request, reply) => {
      const { source } = request.params as { source: string }
      const key = `ingest:${request.ip}:${source in ingestion.sources() ? source : 'unknown'}`
      const check = lockout.check(key)
      if (!check.allowed) {
        return reply
          .header('retry-after', String(check.retryAfterSeconds))
          .status(429)
          .send({ error: 'ingestion endpoint temporarily locked' })
      }
      const response = await ingestion.handleWebhook(source, {
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        headers: request.headers,
        query: request.query as Record<string, unknown>,
      })
      if (response.status === 401) lockout.recordFailure(key)
      else lockout.recordSuccess(key)
      if (response.retryAfterSeconds !== undefined) {
        reply.header('retry-after', String(response.retryAfterSeconds))
      }
      return reply.status(response.status).send(response.body)
    })
  })
}
