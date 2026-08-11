import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ImportApplyResponseSchema,
  ImportPlanSchema,
  OnboardingStatusSchema,
  type OnboardingStatus,
} from '@veduta/protocol'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveConnectionsConfig } from './connections-config.ts'
import type { SecretResolver } from './model-routing.ts'
import { saveOnboardingConfig } from './onboarding-config.ts'
import { registerOnboardingRoutes, type OnboardingRoutesDeps } from './onboarding-routes.ts'
import { SecretsVault } from './secrets-vault.ts'
import { SpacesEngine } from './spaces-engine.ts'

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const noSecrets: SecretResolver = { resolve: () => undefined }

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
    secrets: noSecrets,
    ...overrides,
  }
}

/** A `connected` connection with a stored selection -- satisfies `assertModelConnectionReady` on every profile, including `vps`, where there is no development mock control to fall back on. */
function connectAndSelectAnthropic(dir: string): void {
  saveConnectionsConfig(dir, {
    version: 1,
    connections: [
      {
        id: 'anthropic',
        method: 'anthropic-api-key',
        provider: 'anthropic',
        label: 'Claude',
        state: 'connected',
        stateAt: '2026-08-09T00:00:00.000Z',
        enabledForFallback: false,
        createdAt: '2026-08-09T00:00:00.000Z',
        selectedModelId: 'claude-sonnet-5',
      },
    ],
    selection: { connectionId: 'anthropic', modelId: 'claude-sonnet-5' },
    mockEnabled: false,
  })
}

function buildApp(deps: OnboardingRoutesDeps): FastifyInstance {
  const app = Fastify()
  registerOnboardingRoutes(app, deps)
  return app
}

/** The flat staged layout the installer writes (`docs/adr/0010-importer-trust-and-refusal.md`): `<root>/import-source/hermes/{SOUL,USER,MEMORY}.md`. */
function buildStagedHermesFixture(dir: string): string {
  const stagedDir = join(dir, 'import-source', 'hermes')
  mkdirSync(stagedDir, { recursive: true })
  writeFileSync(join(stagedDir, 'SOUL.md'), 'You are calm and thorough.\n')
  writeFileSync(join(stagedDir, 'USER.md'), 'Name: Test User\nTimezone: UTC\n')
  writeFileSync(join(stagedDir, 'MEMORY.md'), 'Prefers async updates.\n§\nShips on Thursdays.')
  return stagedDir
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
  it('walks migration -> domain -> model-connection -> first-space -> integrations(skip) -> finish, never scheduling exit', async () => {
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

    // Loopback: the mock provider is automatic, so an empty body is enough
    // to satisfy `assertModelConnectionReady` and complete the step.
    const modelConnection = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: {},
    })
    expect(modelConnection.statusCode).toBe(200)

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
    // The completion gate requires every other visible
    // step done first — pin every step here rather than exercising it
    // through the whole wizard, since that's what the flow test above does.
    // The `vps` profile has no development mock control, so the Model
    // connection readiness gate needs a real connected+selected fixture.
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        'model-connection': 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })
    connectAndSelectAnthropic(dir)
    const scheduleExit = vi.fn()
    const app = buildApp(baseDeps(dir, { profile: 'vps', scheduleExit }))

    const finish = await app.inject({ method: 'POST', url: '/api/onboarding/finish', payload: {} })
    expect(finish.statusCode).toBe(200)
    expect(finish.json()).toEqual({ restartRequired: true, restarting: true })
    expect(scheduleExit).toHaveBeenCalledTimes(1)

    await app.close()
  })

  it('schedules exit on finish on the local-vps profile too (issue 023: the runner loop plays the systemd role)', async () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        'model-connection': 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })
    saveConnectionsConfig(dir, { version: 1, connections: [], mockEnabled: true })
    const scheduleExit = vi.fn()
    const app = buildApp(baseDeps(dir, { profile: 'local-vps', scheduleExit }))

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
    await app.inject({ method: 'POST', url: '/api/onboarding/model-connection', payload: {} })

    const status = (
      await app.inject({ method: 'GET', url: '/api/onboarding' })
    ).json() as OnboardingStatus
    expect(status.currentStep).toBe('first-space')

    await app.close()
  })
})

describe('the removed byok/models routes (issue #47: replaced by Model connections)', () => {
  it.each([
    ['/api/onboarding/byok/test', { provider: 'anthropic', key: 'sk-test-key' }],
    ['/api/onboarding/byok', { skip: true }],
    ['/api/onboarding/models', { tiers: {} }],
  ])('POST %s returns 410 with a reload instruction', async (url, payload) => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({ method: 'POST', url, payload })
    expect(res.statusCode).toBe(410)
    expect(res.json()).toEqual({
      error: 'this onboarding step was replaced by Model connections; reload the app to continue',
    })

    await app.close()
  })
})

describe('POST /api/onboarding/model-connection', () => {
  it('completes the step on loopback with an empty body', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: {},
    })
    expect(res.statusCode).toBe(200)
    const status = res.json() as OnboardingStatus
    expect(status.steps.find((step) => step.id === 'model-connection')?.status).toBe('completed')

    await app.close()
  })

  it('refuses on the vps profile with no connected connection, and never completes the step', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir, { profile: 'vps' }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: {},
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe(
      'connect a Model connection and select a model before continuing',
    )

    await app.close()
  })

  it('accepts useMock on local-vps and turns the development mock control on', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir, { profile: 'local-vps' }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: { useMock: true },
    })
    expect(res.statusCode).toBe(200)
    expect((res.json() as OnboardingStatus).modelConnection.mockEnabled).toBe(true)

    await app.close()
  })

  it('refuses useMock on vps with the exact message', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir, { profile: 'vps' }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: { useMock: true },
    })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe(
      'the development mock control is available only on the Local VPS profile',
    )

    await app.close()
  })

  it('an unknown body key -> 400 with zod issues', async () => {
    const dir = freshRoot()
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: { skip: true },
    })
    expect(res.statusCode).toBe(400)

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
    // Renamed `import` -> `import-legacy` (pnpm's own built-in `import`
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
  it('finish with a pending model-connection step -> 409 naming it, not a 500', async () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        // model-connection left pending.
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })
    const app = buildApp(baseDeps(dir))

    const res = await app.inject({ method: 'POST', url: '/api/onboarding/finish', payload: {} })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toContain('model-connection')

    await app.close()
  })

  it('vps: finish refuses until a Model connection is connected and selected, even with every other step done', async () => {
    const dir = freshRoot()
    saveOnboardingConfig(dir, {
      version: 1,
      steps: {
        domain: 'completed',
        'model-connection': 'completed',
        'first-space': 'completed',
        integrations: 'skipped',
      },
    })
    const app = buildApp(baseDeps(dir, { profile: 'vps' }))

    const res = await app.inject({ method: 'POST', url: '/api/onboarding/finish', payload: {} })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toBe(
      'connect a Model connection and select a model before continuing',
    )

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
  it('a corrupted connections.json -> 500 with a generic message, never the internal text', async () => {
    const dir = freshRoot()
    // Simulates an unexpected internal failure (a bug or a hand-edited
    // config), never a user-input problem, so this must map to a generic
    // 500 and never echo the real error text. `vps` ensures
    // `applyModelConnectionStep` actually reads `connections.json` rather
    // than short-circuiting on the loopback profile.
    writeFileSync(join(dir, 'connections.json'), '{not json at all')
    const app = buildApp(baseDeps(dir, { profile: 'vps' }))

    const res = await app.inject({
      method: 'POST',
      url: '/api/onboarding/model-connection',
      payload: {},
    })
    expect(res.statusCode).toBe(500)
    const body = res.json() as { error: string }
    expect(body.error).not.toContain('invalid JSON')
    expect(body.error).not.toContain('connections.json')

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
