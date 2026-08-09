import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  ApplyModelSelectionRequestSchema,
  AuthorizeModelConnectionRequestSchema,
  AuthorizeModelConnectionResponseSchema,
  CreateModelConnectionRequestSchema,
  ModelConnectionCatalogResponseSchema,
  ModelConnectionSchema,
  ModelConnectionsSnapshotSchema,
  MockProviderControlRequestSchema,
  UpdateModelConnectionRequestSchema,
  VerifyModelConnectionRequestSchema,
  VerifyModelConnectionResponseSchema,
  type ModelConnectionsSnapshot,
} from '@veduta/protocol'
import { z } from 'zod'
import {
  connectionErrorFrom,
  ModelConnectionError,
  type ModelConnectionErrorCode,
} from './model-connection-adapter.ts'
import {
  CONNECTION_NOT_FOUND_MESSAGE,
  type ModelConnectionRegistry,
} from './model-connection-registry.ts'
import { sanitizeErrorText } from './model-routing.ts'

/**
 * Everything `registerModelConnectionRoutes` needs (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md`). `registry` owns every
 * mutation and the routes below are thin delegates to it — no business logic
 * lives here beyond request validation and error-to-status mapping.
 *
 * `probe` is `server.ts`'s ONE candidate-config probe implementation
 * (the same closure the registry's own `AdapterContext.probe` calls through
 * its constructor option): it derives a throwaway `RuntimeRoutingConfig` as
 * though `connectionId` WERE the active selection for `modelId`, builds a
 * throwaway provider bridge over it, and runs one real inference call. That
 * indirection is why `POST /selection`'s verify-then-commit flow needs its
 * own copy of it here rather than going through the registry alone: the
 * probe for a *candidate* selection must run OUTSIDE the registry's mutation
 * queue (so a slow provider round-trip never blocks every other connection
 * mutation), while `registry.applySelectionPrepared`/`commitSelection`
 * bracket it with the compare-and-swap generation check.
 */
export interface ModelConnectionRoutesDeps {
  registry: ModelConnectionRegistry
  profile: 'loopback' | 'local-vps' | 'vps'
  probe: (connectionId: string, modelId: string) => Promise<void>
}

/** A request body that must be empty (or absent) — `.strict()` so an unexpected key is a 400, not silently ignored (the same discipline as `onboarding-routes.ts`'s own copy). */
const EmptyBodySchema = z.object({}).strict()

/** 400 with the zod issues when `body` is neither `undefined` nor an empty object; `undefined` otherwise. */
function rejectUnexpectedBody(reply: FastifyReply, body: unknown): FastifyReply | undefined {
  if (body === undefined) return undefined
  const parsed = EmptyBodySchema.safeParse(body)
  if (parsed.success) return undefined
  return reply.status(400).send({ error: parsed.error.issues })
}

/** Every `ModelConnectionErrorCode` maps to exactly one HTTP status (issue #47): a `Record` over the full union so a future code addition is a compile error here until it is placed, rather than silently falling through to 500. */
const STATUS_FOR_CODE: Record<ModelConnectionErrorCode, number> = {
  unsupported: 409,
  expired: 409,
  unauthorized: 400,
  rejected: 400,
  unreachable: 502,
  internal: 500,
}

/**
 * The one error-mapping seam every Model connection route shares (issue
 * #47): a `ModelConnectionError` whose message is the registry's own
 * "no such Model connection" (`CONNECTION_NOT_FOUND_MESSAGE`) maps to 404
 * with a stable message, ahead of the code-based mapping — every other
 * `ModelConnectionError` maps through `STATUS_FOR_CODE`, with `'internal'`
 * never echoing the real message (it was never written to be safe to show
 * one). Returns whether it handled the error, so a caller with its own
 * error types (`onboarding-routes.ts`'s `sendStepError`, once
 * `applyModelConnectionStep` can throw a `ModelConnectionError` too) can
 * chain this ahead of its own mapping without swallowing errors it does not
 * recognize, and so this module's own routes know to fall back to a generic
 * 500 when it returns `false`.
 */
export function sendModelConnectionError(reply: FastifyReply, error: unknown): boolean {
  if (!(error instanceof ModelConnectionError)) return false
  if (error.message === CONNECTION_NOT_FOUND_MESSAGE) {
    reply.status(404).send({ error: 'unknown Model connection' })
    return true
  }
  const message = error.code === 'internal' ? 'internal error' : error.message
  reply.status(STATUS_FOR_CODE[error.code]).send({ error: message })
  return true
}

async function currentSnapshot(deps: ModelConnectionRoutesDeps): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(await deps.registry.snapshot())
}

/**
 * Runs `fn`, mapping any thrown `ModelConnectionError` through
 * `sendModelConnectionError` and anything else to a generic 500 that never
 * echoes the real message — the shared tail of every route below.
 */
async function guarded<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (error) {
    if (sendModelConnectionError(reply, error)) return undefined
    reply.status(500).send({ error: 'internal error' })
    return undefined
  }
}

/**
 * Registers `/api/model-connections*` directly on `app` (issue #47) — the
 * caller (`buildServer`) registers these on the same top-level instance as
 * `registerOnboardingRoutes` and every other `/api/*` route, so the existing
 * production `onRequest` auth hook covers them too; nothing here is added
 * to `isPublicUnauthenticatedPath`. Every POST/PATCH validates its body
 * with the matching `@veduta/protocol` schema (bad body → 400 with the zod
 * issues), and every response body is validated with the matching protocol
 * schema before it leaves the daemon — a shape only the registry could get
 * wrong, but a schema mismatch here is a daemon bug, not something the PWA
 * should ever have to defend against silently.
 */
export function registerModelConnectionRoutes(
  app: FastifyInstance,
  deps: ModelConnectionRoutesDeps,
): void {
  app.get('/api/model-connections', async () => currentSnapshot(deps))

  app.post('/api/model-connections', async (request, reply) => {
    const parsed = CreateModelConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    return guarded(reply, async () =>
      ModelConnectionsSnapshotSchema.parse(await deps.registry.create(parsed.data)),
    )
  })

  app.post('/api/model-connections/:id/authorize', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = AuthorizeModelConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    return guarded(reply, async () => {
      const snapshot = await deps.registry.authorize(id, parsed.data)
      // `authorize` mutates and returns the WHOLE snapshot (registry.ts) —
      // the wire response is just this one connection's own state/challenge.
      const connection = snapshot.connections.find((candidate) => candidate.id === id)
      if (!connection) {
        throw new ModelConnectionError('rejected', CONNECTION_NOT_FOUND_MESSAGE)
      }
      return AuthorizeModelConnectionResponseSchema.parse({
        state: connection.state,
        ...(connection.challenge === undefined ? {} : { challenge: connection.challenge }),
      })
    })
  })

  app.get('/api/model-connections/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return guarded(reply, async () => ModelConnectionSchema.parse(await deps.registry.read(id)))
  })

  app.post('/api/model-connections/:id/catalog', async (request, reply) => {
    const { id } = request.params as { id: string }
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    return guarded(reply, async () =>
      ModelConnectionCatalogResponseSchema.parse({ models: await deps.registry.catalog(id) }),
    )
  })

  app.post('/api/model-connections/:id/verify', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = VerifyModelConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    return guarded(reply, async () => {
      try {
        await deps.registry.verify(id, parsed.data.modelId)
      } catch (error) {
        // A verify failure is a test result, not an HTTP error: 200
        // either way, with the provider's exact (sanitized) failure text.
        // A missing connection is the one exception — `connectionErrorFrom`
        // passes an existing `ModelConnectionError` through unchanged, so
        // the not-found message still reaches `sendModelConnectionError`'s
        // 404 branch via the rethrow below.
        const err = connectionErrorFrom(error)
        if (err.message === CONNECTION_NOT_FOUND_MESSAGE) throw err
        return VerifyModelConnectionResponseSchema.parse({ result: 'failed', reason: err.message })
      }
      return VerifyModelConnectionResponseSchema.parse({ result: 'ok' })
    })
  })

  app.patch('/api/model-connections/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const parsed = UpdateModelConnectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    return guarded(reply, async () =>
      ModelConnectionsSnapshotSchema.parse(await deps.registry.update(id, parsed.data)),
    )
  })

  app.delete('/api/model-connections/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    return guarded(reply, async () =>
      ModelConnectionsSnapshotSchema.parse(await deps.registry.remove(id)),
    )
  })

  // Verify-then-commit: the probe for the CANDIDATE selection runs
  // outside the registry's mutation queue, between `applySelectionPrepared`
  // (which validates the target and snapshots the generation counter) and
  // `commitSelection` (which rejects with the try-again reason if anything
  // else mutated a connection while the probe was running, and otherwise
  // persists the selection and swaps the live router atomically). Nothing
  // is written or swapped until the probe succeeds.
  app.post('/api/model-connections/selection', async (request, reply) => {
    const parsed = ApplyModelSelectionRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    const { connectionId, modelId } = parsed.data
    return guarded(reply, async () => {
      const prepared = await deps.registry.applySelectionPrepared(connectionId, modelId)
      try {
        await deps.probe(connectionId, modelId)
      } catch (error) {
        throw new ModelConnectionError('rejected', sanitizeErrorText(error))
      }
      await deps.registry.commitSelection(prepared)
      return currentSnapshot(deps)
    })
  })

  app.post('/api/model-connections/mock', async (request, reply) => {
    const parsed = MockProviderControlRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    if (deps.profile !== 'local-vps') {
      return reply
        .status(409)
        .send({ error: 'mock provider control is available only on the Local VPS profile' })
    }
    return guarded(reply, async () =>
      ModelConnectionsSnapshotSchema.parse(await deps.registry.setMockEnabled(parsed.data.enabled)),
    )
  })
}
