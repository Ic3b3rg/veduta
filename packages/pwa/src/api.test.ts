import type { ImportPlan, ImportResult, OnboardingStatus } from '@veduta/protocol'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  errorMessageFromBody,
  expiresInLabel,
  fastActionIdempotencyKey,
  freshnessLabel,
  optimisticFastSurface,
  previewLegacyImport,
  runLegacyImport,
} from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fully schema-valid `ImportPlan`, built by hand rather than `fromPartial`
 * (issue 020, `tasks/plan.md` T8): `previewLegacyImport`/`runLegacyImport`
 * really parse this through `ImportPlanSchema`, so a merely-typed partial
 * would not exercise the real validation path. */
function buildImportPlan(): ImportPlan {
  return {
    source: 'hermes',
    sourceDir: '/data/import-source/hermes',
    options: { overwrite: false, secrets: false },
    items: [{ action: 'import', target: 'FACTS.md', detail: 'Prefers async updates.' }],
    warnings: ['imported memory is stored as untrusted content'],
    notMigrated: ['sessions/ (runtime state, never migrated)'],
    blocked: [],
    requiresOverwrite: false,
  }
}

function buildImportResult(plan: ImportPlan): ImportResult {
  return {
    plan,
    backupPath: '/data/backups/backup-20260727.db',
    archiveDir: '/data/import-archive/hermes-20260727',
    notesPath: '/data/import-archive/hermes-20260727/NOTES.md',
    facts: { added: 3, updated: 0, superseded: 0, noop: 1, overflow: 0 },
    eventsAppended: 2,
    soulUpdated: true,
    userUpdated: true,
    secretsImported: [],
  }
}

function buildOnboardingStatus(): OnboardingStatus {
  return {
    required: false,
    completed: true,
    profile: 'loopback',
    currentStep: null,
    steps: [],
    legacy: { openclaw: false, hermes: false },
    domain: { domain: null, tlsActive: false },
    byok: { vaultAvailable: true, providers: [] },
    models: {
      tiers: {
        triage: [{ provider: 'anthropic', modelId: 'claude-haiku' }],
        reasoning: [{ provider: 'anthropic', modelId: 'claude-sonnet' }],
      },
    },
    firstSpace: { suggestedName: 'Home', existingSpaces: [] },
    integrations: {
      gmail: { configured: false, hasCredentials: false },
      calendar: { configured: false, hasCredentials: false },
    },
  }
}

describe('previewLegacyImport', () => {
  it('posts the source/overwrite/secrets body and parses the response against ImportPlanSchema', async () => {
    const plan = buildImportPlan()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify(plan), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await previewLegacyImport(
      { source: 'hermes', overwrite: false, secrets: false },
      'test-token',
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const [path, init] = call
    expect(path).toBe('/api/onboarding/migration/preview')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      source: 'hermes',
      overwrite: false,
      secrets: false,
    })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' })
    expect(result).toEqual(plan)
  })
})

describe('runLegacyImport', () => {
  it('posts the apply body and parses {result, status} against ImportApplyResponseSchema', async () => {
    const plan = buildImportPlan()
    const body = { result: buildImportResult(plan), status: buildOnboardingStatus() }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const response = await runLegacyImport({ source: 'hermes', overwrite: true, secrets: false })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const [path, init] = call
    expect(path).toBe('/api/onboarding/migration/import')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({
      source: 'hermes',
      overwrite: true,
      secrets: false,
    })
    expect(response.result.backupPath).toBe(body.result.backupPath)
    expect(response.status.completed).toBe(true)
  })
})

describe('freshnessLabel', () => {
  const now = Date.parse('2026-07-03T12:00:00.000Z')

  it('says "just now" under a minute', () => {
    expect(freshnessLabel('2026-07-03T11:59:40.000Z', now)).toBe('just now')
  })

  it('uses minutes under an hour', () => {
    expect(freshnessLabel('2026-07-03T11:15:00.000Z', now)).toBe('45m ago')
  })

  it('uses hours under a day and days beyond', () => {
    expect(freshnessLabel('2026-07-03T09:00:00.000Z', now)).toBe('3h ago')
    expect(freshnessLabel('2026-07-01T12:00:00.000Z', now)).toBe('2d ago')
  })
})

describe('expiresInLabel', () => {
  const now = Date.parse('2026-07-03T12:00:00.000Z')

  it('counts down in minutes, then hours, then days', () => {
    expect(expiresInLabel('2026-07-03T12:05:00.000Z', now)).toBe('expires in 5m')
    expect(expiresInLabel('2026-07-03T15:00:00.000Z', now)).toBe('expires in 3h')
    expect(expiresInLabel('2026-07-05T12:00:00.000Z', now)).toBe('expires in 2d')
  })

  it('reports "expired" once the deadline has passed', () => {
    expect(expiresInLabel('2026-07-03T11:59:00.000Z', now)).toBe('expired')
    expect(expiresInLabel('2026-07-03T12:00:00.000Z', now)).toBe('expired')
  })
})

describe('fastActionIdempotencyKey', () => {
  it('is stable for the same Surface version and changes after freshness advances', () => {
    const input = {
      surfaceId: 'srf-groceries',
      surfaceUpdatedAt: '2026-07-03T10:00:00.000Z',
      nodeId: 'milk',
      actionName: 'toggle',
      value: true,
    }

    expect(fastActionIdempotencyKey(input)).toBe(fastActionIdempotencyKey(input))
    expect(
      fastActionIdempotencyKey({
        ...input,
        surfaceUpdatedAt: '2026-07-03T10:01:00.000Z',
      }),
    ).not.toBe(fastActionIdempotencyKey(input))
    expect(fastActionIdempotencyKey(input).length).toBeLessThan(128)
  })
})

describe('errorMessageFromBody', () => {
  const cases: { name: string; status: number; path: string; body: unknown; expected: string }[] = [
    {
      name: 'a string error field (VaultUnavailableError, 409) is used verbatim (Hermes-style dead-end command)',
      status: 409,
      path: '/api/onboarding/byok',
      body: { error: 'run: sudo systemctl restart veduta' },
      expected: 'run: sudo systemctl restart veduta',
    },
    {
      name: 'a string error field (OnboardingStepError, 400) is used verbatim',
      status: 400,
      path: '/api/onboarding/first-space',
      body: { error: 'a first Space already exists' },
      expected: 'a first Space already exists',
    },
    {
      name: 'a string error field (generic 500 fallback) is used verbatim',
      status: 500,
      path: '/api/onboarding/finish',
      body: { error: 'onboarding step failed unexpectedly' },
      expected: 'onboarding step failed unexpectedly',
    },
    {
      name: 'a multi-line migration dead-end (409, unreadable source) keeps its newlines and exact quoted command intact -- it must stay copyable, not reflowed',
      status: 409,
      path: '/api/onboarding/migration/preview',
      body: {
        error:
          "no readable hermes install was found: this daemon runs under ProtectHome=yes and usually cannot read the admin's home directory, and no staged copy was found at /data/import-source/hermes.\nRun the import from a shell that can read it instead:\n  sudo pnpm --filter @veduta/daemon import hermes --root '/data' --apply",
      },
      expected:
        "no readable hermes install was found: this daemon runs under ProtectHome=yes and usually cannot read the admin's home directory, and no staged copy was found at /data/import-source/hermes.\nRun the import from a shell that can read it instead:\n  sudo pnpm --filter @veduta/daemon import hermes --root '/data' --apply",
    },
    {
      name: 'an empty string error field falls back to the status message',
      status: 400,
      path: '/api/onboarding/models',
      body: { error: '' },
      expected: '/api/onboarding/models failed: 400',
    },
    {
      name: 'zod issues under `error` (the actual daemon shape -- onboarding-routes.ts/server.ts reply with {error: parsed.error.issues} on a bad body) are rendered as a compact "path: message" list',
      status: 400,
      path: '/api/onboarding/first-space',
      body: {
        error: [
          { path: ['name'], message: 'String must contain at least 1 character(s)' },
          { path: [], message: 'expected object' },
        ],
      },
      expected:
        '/api/onboarding/first-space failed: name: String must contain at least 1 character(s); expected object',
    },
    {
      name: 'an empty zod issues array under `error` falls back to the status message',
      status: 400,
      path: '/api/onboarding/byok',
      body: { error: [] },
      expected: '/api/onboarding/byok failed: 400',
    },
    {
      name: 'zod issues under a top-level `issues` key (kept for defensiveness/forward-compat, though no current route emits this shape) are rendered the same way',
      status: 400,
      path: '/api/onboarding/domain',
      body: {
        issues: [{ path: ['domain'], message: 'Required' }],
      },
      expected: '/api/onboarding/domain failed: domain: Required',
    },
    {
      name: 'an empty top-level issues array falls back to the status message',
      status: 400,
      path: '/api/onboarding/domain',
      body: { issues: [] },
      expected: '/api/onboarding/domain failed: 400',
    },
    {
      name: 'a body with neither shape falls back to the status message',
      status: 500,
      path: '/api/onboarding/finish',
      body: { message: 'internal error' },
      expected: '/api/onboarding/finish failed: 500',
    },
    {
      name: 'an unparseable body (undefined) falls back to the status message',
      status: 503,
      path: '/api/spaces',
      body: undefined,
      expected: '/api/spaces failed: 503',
    },
    {
      name: 'a non-object body falls back to the status message',
      status: 502,
      path: '/api/onboarding/integrations',
      body: 'oops',
      expected: '/api/onboarding/integrations failed: 502',
    },
  ]

  for (const { name, status, path, body, expected } of cases) {
    it(name, () => {
      expect(errorMessageFromBody(status, path, body)).toBe(expected)
    })
  }
})

describe('optimisticFastSurface', () => {
  it('updates the declared fast-action state key before the Gateway round trip completes', () => {
    const surface = SurfaceSchema.parse({
      id: 'srf-groceries',
      spaceId: 'spc-home',
      title: 'Groceries',
      tree: {
        id: 'root',
        type: 'Box',
        children: [
          {
            id: 'milk',
            type: 'Checkbox',
            binding: 'milk',
            props: { label: 'Milk' },
            actions: [{ name: 'toggle', path: 'fast', stateKey: 'milk' }],
          },
        ],
      },
      state: { milk: false },
      freshness: { updatedAt: '2026-07-03T10:00:00.000Z', updatedBy: 'seed' },
    })

    const milkNode = surface.tree.children?.[0]
    if (!milkNode) throw new Error('expected milk node in test Surface')

    const optimistic = optimisticFastSurface(
      surface,
      milkNode,
      'toggle',
      true,
      '2026-07-03T10:00:01.000Z',
    )

    expect(optimistic.state['milk']).toBe(true)
    expect(optimistic.freshness).toEqual({
      updatedAt: '2026-07-03T10:00:01.000Z',
      updatedBy: 'user',
    })
  })
})
