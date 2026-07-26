import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  ByokApplyRequestSchema,
  ByokTestRequestSchema,
  ByokTestResponseSchema,
  FinishResponseSchema,
  FirstSpaceRequestSchema,
  IntegrationsApplyRequestSchema,
  MigrationChoiceRequestSchema,
  ModelsApplyRequestSchema,
  OnboardingStatusSchema,
  type OnboardingStatus,
} from '@veduta/protocol'
import { z } from 'zod'
import { applyByok, testProviderKey } from './onboarding-step-byok.ts'
import { confirmDomain } from './onboarding-step-domain.ts'
import { applyFinish } from './onboarding-step-finish.ts'
import { applyFirstSpace } from './onboarding-step-first-space.ts'
import { applyIntegrations } from './onboarding-step-integrations.ts'
import { applyMigrationChoice } from './onboarding-step-migration.ts'
import { applyModels } from './onboarding-step-models.ts'
import {
  buildOnboardingStatus,
  OnboardingStepError,
  VaultUnavailableError,
} from './onboarding-status.ts'
import type { SecretsVault } from './secrets-vault.ts'
import type { SpacesEngine } from './spaces-engine.ts'

/**
 * `tasks/plan.md` §4/T4: everything `registerOnboardingRoutes` needs to wire
 * `/api/onboarding/*` up to the T3 step modules. The vault is opened once by
 * `buildServer` (decision 9) and threaded through here rather than reopened —
 * two `SecretsVault` instances writing the same file would race.
 * `scheduleExit` is `applyFinish`'s injectable graceful-exit hook (VPS
 * profile only); `fetchImpl` lets tests stub the BYOK key check without a
 * real network call.
 */
export interface OnboardingRoutesDeps {
  rootDir: string
  profile: 'loopback' | 'vps'
  domain: string | null
  tlsActive: boolean
  vault: SecretsVault | undefined
  spacesEngine: SpacesEngine
  env: NodeJS.ProcessEnv
  scheduleExit: () => void
  fetchImpl?: typeof fetch
}

/** A request body that must be empty (or absent) — `.strict()` so an unexpected key is a 400, not silently ignored (issue #19 code review fix). */
const EmptyBodySchema = z.object({}).strict()

function currentStatus(deps: OnboardingRoutesDeps): OnboardingStatus {
  const status = buildOnboardingStatus({
    rootDir: deps.rootDir,
    profile: deps.profile,
    domain: deps.domain,
    tlsActive: deps.tlsActive,
    listSpaces: () => deps.spacesEngine.listSpaces(),
    env: deps.env,
    ...(deps.vault === undefined ? {} : { vault: deps.vault }),
  })
  // Validated before it ever leaves the daemon (code review fix): a status
  // shape only `buildOnboardingStatus` could get wrong, but a schema
  // mismatch here is a daemon bug, not something the PWA should ever have to
  // defend against silently.
  return OnboardingStatusSchema.parse(status)
}

/**
 * The one error-mapping seam every onboarding route shares (T4 spec, code
 * review fix): `VaultUnavailableError` (decision 9's dead-end copy) maps to
 * 409; `OnboardingStepError` (a step module's own user-facing failure —
 * missing credential, first-space-before-integrations, an empty slug, the
 * finish completion gate) maps to its own `statusCode`, defaulting to 400;
 * anything else is unexpected (a bug, not bad input) and maps to a generic
 * 500 — its real message is never echoed to the client, since it was never
 * written to be safe to show one.
 */
function sendStepError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof VaultUnavailableError) {
    return reply.status(409).send({ error: error.message })
  }
  if (error instanceof OnboardingStepError) {
    return reply.status(error.statusCode ?? 400).send({ error: error.message })
  }
  return reply.status(500).send({ error: 'onboarding step failed unexpectedly' })
}

/** 400 with the zod issues when `body` is neither `undefined` nor an empty object; `undefined` otherwise. */
function rejectUnexpectedBody(reply: FastifyReply, body: unknown): FastifyReply | undefined {
  if (body === undefined) return undefined
  const parsed = EmptyBodySchema.safeParse(body)
  if (parsed.success) return undefined
  return reply.status(400).send({ error: parsed.error.issues })
}

/**
 * Registers `GET /api/onboarding` and every `POST /api/onboarding/*` step
 * endpoint (`tasks/plan.md` §4) directly on `app` — the caller
 * (`buildServer`) registers these on the same top-level instance as every
 * other `/api/*` route, so the existing production `onRequest` auth hook
 * covers them too; nothing here is added to `isPublicUnauthenticatedPath`.
 * Every POST validates its body with the matching `@veduta/protocol` schema
 * (bad body -> 400 with the zod issues, mirroring every other route in
 * `server.ts`), applies its step (side effects first, per decision 4), and
 * replies with a fresh `GET`-equivalent status — except `byok/test` (a pure
 * check, no step to complete) and `finish` (its own response shape).
 */
export function registerOnboardingRoutes(app: FastifyInstance, deps: OnboardingRoutesDeps): void {
  app.get('/api/onboarding', () => currentStatus(deps))

  app.post('/api/onboarding/migration', (request, reply) => {
    const parsed = MigrationChoiceRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      applyMigrationChoice(deps.rootDir, parsed.data.choice)
    } catch (error) {
      return sendStepError(reply, error)
    }
    return currentStatus(deps)
  })

  app.post('/api/onboarding/domain', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    try {
      confirmDomain(deps.rootDir)
    } catch (error) {
      return sendStepError(reply, error)
    }
    return currentStatus(deps)
  })

  app.post('/api/onboarding/byok/test', async (request, reply) => {
    const parsed = ByokTestRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })

    let key: string
    if (parsed.data.key !== undefined) {
      key = parsed.data.key
    } else {
      // Keep-existing sentinel (decision 4/7): test whatever key is already
      // stored for this provider instead of requiring it be resubmitted.
      const stored = deps.vault?.resolve(`secret://vault/${parsed.data.provider}`)
      if (stored === undefined) {
        return reply.status(400).send({
          error: `no stored key for ${parsed.data.provider}; submit a key to test, or store one first`,
        })
      }
      key = stored
    }

    const result = await testProviderKey(parsed.data.provider, key, deps.fetchImpl ?? fetch)
    return ByokTestResponseSchema.parse({ result })
  })

  app.post('/api/onboarding/byok', (request, reply) => {
    const parsed = ByokApplyRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      applyByok({ rootDir: deps.rootDir, vault: deps.vault }, parsed.data)
    } catch (error) {
      return sendStepError(reply, error)
    }
    return currentStatus(deps)
  })

  app.post('/api/onboarding/models', (request, reply) => {
    const parsed = ModelsApplyRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      applyModels(deps.rootDir, parsed.data.tiers)
    } catch (error) {
      return sendStepError(reply, error)
    }
    return currentStatus(deps)
  })

  app.post('/api/onboarding/first-space', (request, reply) => {
    const parsed = FirstSpaceRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      applyFirstSpace({ rootDir: deps.rootDir, spacesEngine: deps.spacesEngine }, parsed.data)
    } catch (error) {
      return sendStepError(reply, error)
    }
    return currentStatus(deps)
  })

  app.post('/api/onboarding/integrations', (request, reply) => {
    const parsed = IntegrationsApplyRequestSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    try {
      applyIntegrations(
        { rootDir: deps.rootDir, vault: deps.vault, domain: deps.domain },
        parsed.data,
      )
    } catch (error) {
      return sendStepError(reply, error)
    }
    return currentStatus(deps)
  })

  app.post('/api/onboarding/finish', (request, reply) => {
    const bodyError = rejectUnexpectedBody(reply, request.body)
    if (bodyError) return bodyError
    try {
      const result = applyFinish({
        rootDir: deps.rootDir,
        profile: deps.profile,
        scheduleExit: deps.scheduleExit,
        env: deps.env,
      })
      return FinishResponseSchema.parse(result)
    } catch (error) {
      return sendStepError(reply, error)
    }
  })
}
