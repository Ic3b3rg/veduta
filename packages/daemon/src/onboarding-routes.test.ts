import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  ImportApplyResponseSchema,
  ImportPlanSchema,
  OnboardingStatusSchema,
  type OnboardingStatus,
} from '@veduta/protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveOnboardingConfig } from './onboarding-config.ts'
import { registerOnboardingRoutes, type OnboardingRoutesDeps } from './onboarding-routes.ts'
import { SecretsVault } from './secrets-vault.ts'
import { SpacesEngine } from './spaces-engine.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const VALID_TIERS = {
  triage: [{ provider: 'anthropic', modelId: 'claude-haiku' }],
  reasoning: [{ provider: 'anthropic', modelId: 'claude-sonnet' }],
}

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-routes-'))
  return rootDir
}

function baseDeps(
  dir: string,
  overrides: Partial<OnboardingRoutesDeps> = {},
): OnboardingRoutesDeps {
  return {
    rootDir: dir,
    profile: 'loopback',
    domain: null,
    tlsActive: false,
    vault: undefined,
    vaultKeyMaterial: undefined,
    spacesEngine: new SpacesEngine({ rootDir: dir, seed: { spaces: [], surfaces: [] } }),
    // Pinned to a clean temp dir rather than the real `~` so a stray
    // `.hermes`/`.openclaw` on the host running the tests never changes
    // which steps are visible.
    env: { VEDUTA_LEGACY_HOME: dir },
    scheduleExit: () => {},
    ...overrides,
  }
}

function buildApp(deps: OnboardingRoutesDeps): FastifyInstance {
  const app = Fastify()
  registerOnboardingRoutes(app, deps)
  return app
}

/** The flat staged layout the installer writes (`tasks/plan.md` decision 16): `<root>/import-source/hermes/{SOUL,USER,MEMORY}.md`. */
function buildStagedHermesFixture(dir: string): string {
  const stagedDir = join(dir, 'import-source', 'hermes')
  mkdirSync(stagedDir, { recursive: true })
  writeFileSync(join(stagedDir, 'SOUL.md'), 'You are calm and thorough.\n')
  writeFileSync(join(stagedDir, 'USER.md'), 'Name: Test User\nTimezone: UTC\n')
  writeFileSync(join(stagedDir, 'MEMORY.md'), 'Prefers async updates.\n§\nShips on Thursdays.')
  return stagedDir
}

function okResponse(status: number): Response {
  return fromPartial<Response>({
    status,
    json: () => {
      throw new Error('response body must never be read')
    },
    text: () => {
      throw new Error('response body must never be read')
    },
  })
}

describe('GET /api/onboarding', () => {
  it('returns a status shape that parses with OnboardingStatusSchema', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))
    const res = await app.inject({ method: 'GET', url: '/api/onboarding' })
    expect(res.statusCode).toBe(200)
    const parsed = OnboardingStatusSchema.safeParse(res.json())
    expect(parsed.success).toBe(true)
    await app.close()
  })
})

describe('onboarding wizard flow (loopback)', () => {
  it('walks migration -> domain -> byok(skip) -> models -> first-space -> integrations(skip) -> finish, never scheduling exit', async () => {
    const dir = freshRoot()
    const scheduleExit = vi.fn()
    const app = buildApp(baseDeps(dir, { scheduleExit }))

    const migration = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration',
      payload: { choice: 'manual' },
    })
    expect(migration.statusCode).toBe(200)

    const domain = await app.inject({ method: 'POST', url: '/api/onboarding/domain', payload: {} })
    expect(domain.statusCode).toBe(200)

    const byok = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok',
      payload: { skip: true },
    })
    expect(byok.statusCode).toBe(200)

    const models = await app.inject({
      method: 'POST',
      url: '/api/onboarding/models',
      payload: { tiers: VALID_TIERS },
    })
    expect(models.statusCode).toBe(200)

    const firstSpace = await app.inject({
      method: 'POST',
      url: '/api/onboarding/first-space',
      payload: { name: 'Personal' },
    })
    expect(firstSpace.statusCode).toBe(200)

    const integrations = await app.inject({
      method: 'POST',
      url: '/api/onboarding/integrations',
      payload: { skip: true },
    })
    expect(integrations.statusCode).toBe(200)

    const finish = await app.inject({ method: 'POST', url: '/api/onboarding/finish', payload: {} })
    expect(finish.statusCode).toBe(200)
    expect(finish.json()).toEqual({ restartRequired: true, restarting: false })
    // Loopback profile: the daemon must keep running so the wizard's own
    // "restart to apply" screen (not an actual process exit) is honest.
    expect(scheduleExit).not.toHaveBeenCalled()

    const status = (
      await app.inject({ method: 'GET', url: '/api/onboarding' })
    ).json() as OnboardingStatus
    expect(status.completed).toBe(true)
    expect(status.currentStep).toBeNull()

    await app.close()
  })

  it('schedules exit on finish only on the vps profile', async () => {
    const dir = freshRoot()
    // The completion gate (code review fix) requires every other visible
    // step done first — pin every step here rather than exercising it
    // through the whole wizard, since that's what the flow test above does.
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        byok: 'skipped',
        models: 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })
    const scheduleExit = vi.fn()
    const app = buildApp(baseDeps(dir, { profile: 'vps', scheduleExit }))

    const finish = await app.inject({ method: 'POST', url: '/api/onboarding/finish', payload: {} })
    expect(finish.statusCode).toBe(200)
    expect(finish.json()).toEqual({ restartRequired: true, restarting: true })
    expect(scheduleExit).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('resume: after completing two steps, GET status currentStep is the third', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    await app.inject({ method: 'POST', url: '/api/onboarding/domain', payload: {} })
    await app.inject({ method: 'POST', url: '/api/onboarding/byok', payload: { skip: true } })

    const status = (
      await app.inject({ method: 'GET', url: '/api/onboarding' })
    ).json() as OnboardingStatus
    expect(status.currentStep).toBe('models')

    await app.close()
  })
})

describe('POST /api/onboarding/byok/test', () => {
  it('valid: a stubbed 2xx maps to result "valid"', async () => {
    const dir = freshRoot()
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200))
    const app = buildApp(baseDeps(dir, { fetchImpl }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok/test',
      payload: { provider: 'anthropic', key: 'sk-test-key' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ result: 'valid' })

    await app.close()
  })

  it('invalid: a stubbed 401 maps to result "invalid"', async () => {
    const dir = freshRoot()
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(401))
    const app = buildApp(baseDeps(dir, { fetchImpl }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok/test',
      payload: { provider: 'openai', key: 'sk-test-key' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ result: 'invalid' })

    await app.close()
  })

  it('key omitted with no stored key -> 400 with a clear message, never a fetch call', async () => {
    const dir = freshRoot()
    const fetchImpl = vi.fn()
    const app = buildApp(baseDeps(dir, { fetchImpl }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok/test',
      payload: { provider: 'anthropic' },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('anthropic')
    expect(fetchImpl).not.toHaveBeenCalled()

    await app.close()
  })

  it('key omitted with a stored key -> tests the stored key (keep-existing sentinel)', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    vault.set('anthropic', 'sk-stored-key')
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(200))
    const app = buildApp(baseDeps(dir, { vault, fetchImpl }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok/test',
      payload: { provider: 'anthropic' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ result: 'valid' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        headers: { 'x-api-key': 'sk-stored-key', 'anthropic-version': '2023-06-01' },
      }),
    )

    await app.close()
  })
})

describe('POST /api/onboarding/byok — vault dead end', () => {
  it('submitting a key with no vault open -> 409 with the exact keyfile commands', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir, { vault: undefined }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok',
      payload: { provider: 'anthropic', key: 'sk-test-key' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string }
    expect(body.error).toContain('VEDUTA_VAULT_KEYFILE')
    expect(body.error).toContain('head -c 48 /dev/urandom')
    expect(body.error).not.toContain('sk-test-key')

    await app.close()
  })
})

describe('POST /api/onboarding/migration/preview', () => {
  it('returns a schema-valid plan for a staged hermes source and writes nothing', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const app = buildApp(baseDeps(dir, { vaultKeyMaterial: KEY_MATERIAL }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/preview',
      payload: { source: 'hermes' },
    })
    expect(res.statusCode).toBe(200)
    expect(ImportPlanSchema.safeParse(res.json()).success).toBe(true)

    await app.close()
  })

  it('no readable source -> 409 with the exact CLI command', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir, { vaultKeyMaterial: KEY_MATERIAL }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/preview',
      payload: { source: 'hermes' },
    })
    expect(res.statusCode).toBe(409)
    const body = res.json() as { error: string }
    // B1: renamed `import` -> `import-legacy` (pnpm's own built-in `import`
    // command shadowed the old script name entirely).
    expect(body.error).toContain('pnpm --filter @veduta/daemon import-legacy hermes')
    expect(body.error).toContain('--apply')

    await app.close()
  })

  it('secrets: true -> 400, CLI-only', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const app = buildApp(baseDeps(dir, { vaultKeyMaterial: KEY_MATERIAL }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/preview',
      payload: { source: 'hermes', secrets: true },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('--secrets')

    await app.close()
  })

  it('a malformed body -> 400 with zod issues', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/preview',
      payload: { source: 'not-a-real-source' },
    })
    expect(res.statusCode).toBe(400)
    expect(Array.isArray((res.json() as { error: unknown }).error)).toBe(true)

    await app.close()
  })
})

describe('POST /api/onboarding/migration/import', () => {
  it('imports a staged hermes source, sets migrationChoice: imported, and returns a schema-valid {result, status}', async () => {
    const dir = freshRoot()
    const staged = buildStagedHermesFixture(dir)
    const app = buildApp(baseDeps(dir, { vaultKeyMaterial: KEY_MATERIAL }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/import',
      payload: { source: 'hermes' },
    })
    expect(res.statusCode).toBe(200)
    const parsed = ImportApplyResponseSchema.safeParse(res.json())
    expect(parsed.success).toBe(true)
    expect(existsSync(staged)).toBe(false)

    await app.close()
  })

  it('a second import without --overwrite -> 409, not 500', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const app = buildApp(baseDeps(dir, { vaultKeyMaterial: KEY_MATERIAL }))

    const first = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/import',
      payload: { source: 'hermes' },
    })
    expect(first.statusCode).toBe(200)

    // The installer would re-stage a re-detected install on a second wizard run.
    buildStagedHermesFixture(dir)
    const second = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/import',
      payload: { source: 'hermes' },
    })
    expect(second.statusCode).toBe(409)
    expect((second.json() as { error: string }).error).toContain('already imported')

    await app.close()
  })

  it('secrets: true -> 400, CLI-only', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const app = buildApp(baseDeps(dir, { vaultKeyMaterial: KEY_MATERIAL }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/import',
      payload: { source: 'hermes', secrets: true },
    })
    expect(res.statusCode).toBe(400)

    await app.close()
  })

  it('a malformed body -> 400 with zod issues', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration/import',
      payload: { source: 'hermes', extra: true },
    })
    expect(res.statusCode).toBe(400)

    await app.close()
  })
})

describe('bad request bodies', () => {
  it('an invalid migration choice -> 400', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/migration',
      payload: { choice: 'not-a-real-choice' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('an empty first-space name -> 400', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/first-space',
      payload: { name: '' },
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('an integrations body with neither gmail nor calendar nor skip -> 400', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))
    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/integrations',
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /api/onboarding/finish — completion gate', () => {
  it('finish with a pending byok step -> 409 naming byok, not a 500', async () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        // byok left pending.
        models: 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({ method: 'POST', url: '/api/onboarding/finish', payload: {} })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toContain('byok')

    await app.close()
  })

  it('an unexpected key in the finish body -> 400', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/finish',
      payload: { unexpected: true },
    })
    expect(res.statusCode).toBe(400)

    await app.close()
  })
})

describe('unexpected internal errors', () => {
  it('a stubbed internal TypeError from a step module -> 500 with a generic message, never the internal text', async () => {
    const dir = freshRoot()
    // A vault double whose `.set` throws — simulates an unexpected internal
    // failure (a bug), never a user-input problem, so this must map to a
    // generic 500 and never echo the real error text (code review fix).
    const vault = fromPartial<SecretsVault>({
      has: () => false,
      set: () => {
        throw new TypeError('boom: an unexpected internal failure')
      },
    })
    const app = buildApp(baseDeps(dir, { vault }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/byok',
      payload: { provider: 'anthropic', key: 'sk-test-key' },
    })
    expect(res.statusCode).toBe(500)
    const body = res.json() as { error: string }
    expect(body.error).not.toContain('boom')
    expect(body.error).not.toContain('TypeError')

    await app.close()
  })
})

describe('user-input step errors', () => {
  it('integrations before first-space -> 400 naming the missing step, not a 500', async () => {
    const dir = freshRoot()
    const vault = SecretsVault.open(dir, KEY_MATERIAL)
    const app = buildApp(baseDeps(dir, { vault }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/integrations',
      payload: {
        gmail: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          refreshToken: 'refresh-token',
          topicName: 'projects/x/topics/y',
          subscription: 'projects/x/subscriptions/z',
        },
      },
    })
    expect(res.statusCode).toBe(400)
    expect((res.json() as { error: string }).error).toContain('first-space')

    await app.close()
  })
})
