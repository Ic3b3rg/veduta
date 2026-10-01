import type {
  FastActionInvocation,
  ImportPlan,
  ImportResult,
  OnboardingStatus,
  Surface,
} from '@veduta/protocol'
import { literalSetPlan, SurfaceSchema } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { committedActionOutcome } from './action-test-support.ts'
import {
  connectGateway,
  errorMessageFromBody,
  expiresInLabel,
  fetchOnboardingStatus,
  fetchSpaces,
  freshnessLabel,
  invokeSurfaceAction,
  moveSurface,
  pinSurface,
  previewLegacyImport,
  runLegacyImport,
  type GatewayHandlers,
} from './api.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** A fully schema-valid `ImportPlan`, built by hand rather than `fromPartial`
 * (issue 020): `previewLegacyImport`/`runLegacyImport` really parse this
 * through `ImportPlanSchema`, so a merely-typed partial would not exercise
 * the real validation path. */
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
    modelConnection: {
      vaultAvailable: true,
      connectedCount: 0,
      hasSelection: false,
      mockEnabled: false,
    },
    firstSpace: { suggestedName: 'Home', existingSpaces: [] },
    integrations: {
      gmail: { configured: false, hasCredentials: false },
      calendar: { configured: false, hasCredentials: false },
    },
  }
}

describe('fetchOnboardingStatus', () => {
  it('preserves a 401 status so the PWA can discard a stale session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'passkey session required' }), { status: 401 }),
      ),
    )

    await expect(fetchOnboardingStatus('stale-token')).rejects.toMatchObject({
      message: 'passkey session required',
      status: 401,
    })
  })
})

describe('fetchSpaces', () => {
  it('preserves a 401 status so cached Home cannot keep a stale session alive', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'passkey session required' }), { status: 401 }),
      ),
    )

    await expect(fetchSpaces('stale-token')).rejects.toMatchObject({
      message: 'passkey session required',
      status: 401,
    })
  })
})

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

function buildSurface(overrides: Partial<Surface> = {}): Surface {
  return SurfaceSchema.parse({
    id: 'srf-meals',
    spaceId: 'spc-health',
    title: 'Meals',
    tree: { id: 'root', type: 'Box', children: [] },
    state: {},
    freshness: { updatedAt: '2026-07-10T12:00:00.000Z', updatedBy: 'agent' },
    ...overrides,
  })
}

describe('invokeSurfaceAction', () => {
  const invocation: FastActionInvocation = {
    nodeId: 'check-now',
    name: 'check',
    actionRevision: 'acr-check-now',
    intentId: '00000000-0000-4000-8000-000000000001',
    inputs: {},
  }
  const requestedSurface = buildSurface({
    tree: {
      id: invocation.nodeId,
      type: 'Button',
      props: { label: 'Check now' },
      actions: [
        {
          name: invocation.name,
          path: 'fast',
          revision: invocation.actionRevision,
          plan: literalSetPlan('requested', true),
        },
      ],
    },
    state: { requested: true },
  })

  it('posts only the typed invocation and returns the canonical committed outcome', async () => {
    const surface = requestedSurface
    const outcome = committedActionOutcome(
      invocation,
      surface,
      {
        surfaceId: surface.id,
        operations: [{ target: 'state', op: 'replace', path: '/requested', value: true }],
      },
      9,
    )
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify(outcome), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await invokeSurfaceAction('srf-meals', invocation, 'test-token')

    expect(result).toEqual(outcome)
    expect(fetchMock).toHaveBeenCalledOnce()
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const [path, init] = call
    expect(path).toBe('/api/surfaces/srf-meals/actions')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' })
    expect(JSON.parse(String(init?.body))).toEqual(invocation)
  })

  it('keeps a declared no-op distinct from a committed mutation', async () => {
    const outcome = {
      outcome: 'noop',
      surfaceId: 'srf-meals',
      nodeId: invocation.nodeId,
      actionName: invocation.name,
      actionRevision: invocation.actionRevision,
      intentId: invocation.intentId,
      reason: 'unchanged',
      duplicate: false,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(outcome))),
    )

    await expect(invokeSurfaceAction('srf-meals', invocation)).resolves.toEqual(outcome)
  })

  it('returns an identifiable recovery-pending outcome without reporting success', async () => {
    const outcome = {
      outcome: 'recovery_pending',
      surfaceId: 'srf-meals',
      nodeId: invocation.nodeId,
      actionName: invocation.name,
      actionRevision: invocation.actionRevision,
      intentId: invocation.intentId,
      surfaceCommitId: 'scm-pending',
      spaceId: 'spc-health',
      duplicate: false,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(outcome), { status: 202 })),
    )

    await expect(invokeSurfaceAction('srf-meals', invocation)).resolves.toEqual(outcome)
  })

  it('rejects an invalid committed snapshot instead of rendering unvalidated state', async () => {
    const outcome = committedActionOutcome(
      invocation,
      requestedSurface,
      {
        surfaceId: 'srf-meals',
        operations: [{ target: 'state', op: 'replace', path: '/requested', value: true }],
      },
      9,
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...outcome,
              surface: { ...outcome.surface, presentation: 'arbitrary' },
            }),
          ),
      ),
    )

    await expect(invokeSurfaceAction('srf-meals', invocation)).rejects.toThrow()
  })

  it('preserves terminal rejection status for visible failure handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'This Action is stale. Refresh the Surface before trying again.',
            }),
            { status: 409 },
          ),
      ),
    )

    await expect(invokeSurfaceAction('srf-meals', invocation)).rejects.toMatchObject({
      status: 409,
      message: 'This Action is stale. Refresh the Surface before trying again.',
    })
  })
})

describe('pinSurface', () => {
  it('posts { pinned } and parses the authoritative mutation result', async () => {
    const surface = buildSurface({ pinned: true })
    const order = {
      cursor: 7,
      spaceId: 'spc-health',
      pinnedSurfaceIds: ['srf-meals'],
      regularSurfaceIds: [],
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ surface, changed: true, order }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await pinSurface('srf-meals', true, 'test-token')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const [path, init] = call
    expect(path).toBe('/api/surfaces/srf-meals/pin')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ pinned: true })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' })
    expect(result).toEqual({ surface, changed: true, order })
  })

  it('rejects with a readable message on a non-2xx response', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: 'Surface is not pinnable' }), { status: 409 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(pinSurface('srf-meals', true)).rejects.toThrow('Surface is not pinnable')
  })
})

describe('moveSurface', () => {
  it('posts one relative direction and parses the authoritative order', async () => {
    const resultBody = {
      changed: true,
      order: {
        cursor: 8,
        spaceId: 'spc-health',
        pinnedSurfaceIds: [],
        regularSurfaceIds: ['srf-b', 'srf-a'],
      },
    }
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify(resultBody), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await moveSurface('spc-health', 'srf-b', 'up', 'test-token')

    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('fetch was not called')
    const [path, init] = call
    expect(path).toBe('/api/spaces/spc-health/surfaces/srf-b/move')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual({ direction: 'up' })
    expect(init?.headers).toMatchObject({ authorization: 'Bearer test-token' })
    expect(result).toEqual(resultBody)
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
      name: 'a pending Surface commit names the saved mutation for recovery',
      status: 503,
      path: '/api/surfaces/srf-groceries/actions',
      body: {
        outcome: 'recovery_pending',
        surfaceCommitId: 'scm-7',
        spaceId: 'spc-health',
      },
      expected: 'Surface commit scm-7 is pending Event recovery in Space spc-health.',
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

// connectGateway's onmessage dispatch (issue 037: PWA-side streaming): a minimal fake socket
// stands in for the browser WebSocket so `ws.onmessage` can be triggered by
// hand with a raw Gateway frame, the same way a real server push would land.
function fakeWebSocket() {
  return {
    onopen: null as (() => void) | null,
    onmessage: null as ((event: { data: string }) => void) | null,
    onclose: null as (() => void) | null,
    readyState: 1,
    send: vi.fn(),
    close: vi.fn(),
  }
}

function connectWithFakeSocket(handlerOverrides: Partial<GatewayHandlers>) {
  const socket = fakeWebSocket()
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
  vi.stubGlobal(
    'WebSocket',
    vi.fn(() => socket),
  )

  const handlers = fromPartial<GatewayHandlers>({
    surfaceCursor: 0,
    onHello: vi.fn(),
    onSurfacePatch: vi.fn(),
    onSurfaceCreated: vi.fn(),
    onSurfaceArchived: vi.fn(),
    onSurfacePinned: vi.fn(),
    onSurfaceMoved: vi.fn(),
    onChatMessage: vi.fn(),
    onChatTurnStart: vi.fn(),
    onChatTurnDelta: vi.fn(),
    onChatTurnReplace: vi.fn(),
    onChatTurnEnd: vi.fn(),
    onChatTurnError: vi.fn(),
    onPendingDecisionLifecycle: vi.fn(),
    onAutomationOutcomeNotificationLifecycle: vi.fn(),
    onApprovalCard: vi.fn(),
    onPresence: vi.fn(),
    onSpaceAttention: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    ...handlerOverrides,
  })

  connectGateway(handlers)
  return { socket, handlers }
}

function deliver(socket: ReturnType<typeof fakeWebSocket>, frame: unknown): void {
  socket.onmessage?.({ data: JSON.stringify(frame) })
}

describe('connectGateway chat.turn-* dispatch', () => {
  it('retains the committed Action identity on one canonical Surface patch', () => {
    const onSurfacePatch = vi.fn()
    const { socket } = connectWithFakeSocket({ onSurfacePatch })
    const frame = {
      type: 'surface.patch',
      event: {
        cursor: 9,
        at: '2026-10-01T10:00:00.000Z',
        spaceId: 'spc-health',
        patch: {
          surfaceId: 'srf-meals',
          operations: [{ target: 'state', op: 'replace', path: '/requested', value: true }],
        },
        freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'user' },
        actionOutcome: {
          outcome: 'committed',
          surfaceId: 'srf-meals',
          nodeId: 'check-now',
          actionName: 'check',
          actionRevision: 'acr-check-now',
          intentId: '00000000-0000-4000-8000-000000000001',
          surfaceVersion: 2,
          treeVersion: 1,
          surfaceCommitId: 'scm-check-now',
          eventCursor: 9,
          surfaceCursor: 9,
          duplicate: false,
        },
      },
    }

    deliver(socket, frame)

    expect(onSurfacePatch).toHaveBeenCalledExactlyOnceWith(frame.event)
  })

  it('rejects a live Action outcome that does not identify its Patch event', () => {
    const onSurfacePatch = vi.fn()
    const onError = vi.fn()
    const { socket } = connectWithFakeSocket({ onSurfacePatch, onError })
    deliver(socket, {
      type: 'surface.patch',
      event: {
        cursor: 9,
        at: '2026-10-01T10:00:00.000Z',
        spaceId: 'spc-health',
        patch: {
          surfaceId: 'srf-meals',
          operations: [{ target: 'state', op: 'replace', path: '/requested', value: true }],
        },
        freshness: { updatedAt: '2026-10-01T10:00:00.000Z', updatedBy: 'user' },
        actionOutcome: {
          outcome: 'committed',
          surfaceId: 'srf-meals',
          nodeId: 'check-now',
          actionName: 'check',
          actionRevision: 'acr-check-now',
          intentId: '00000000-0000-4000-8000-000000000001',
          surfaceVersion: 2,
          treeVersion: 1,
          surfaceCommitId: 'scm-check-now',
          eventCursor: 8,
          surfaceCursor: 8,
          duplicate: false,
        },
      },
    })

    expect(onSurfacePatch).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      'Malformed Gateway frame; refreshing confirmed state.',
    )
  })

  it('dispatches the complete surface.created frame so live correlation is not discarded', () => {
    const onSurfaceCreated = vi.fn()
    const { socket } = connectWithFakeSocket({ onSurfaceCreated })
    const frame = {
      type: 'surface.created',
      event: {
        cursor: 1,
        at: '2026-08-16T10:00:00.000Z',
        spaceId: 'spc-home',
        surface: {
          id: 'srf-created',
          spaceId: 'spc-home',
          title: 'Created',
          tree: { id: 'root', type: 'Box' },
          state: {},
          freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
        },
        order: {
          cursor: 1,
          spaceId: 'spc-home',
          pinnedSurfaceIds: [],
          regularSurfaceIds: ['srf-created'],
        },
      },
      initiatingTurn: { clientId: 'pwa-1', turnId: 'turn-1' },
    }

    deliver(socket, frame)

    expect(onSurfaceCreated).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'surface.created',
        initiatingTurn: { clientId: 'pwa-1', turnId: 'turn-1' },
      }),
    )
  })

  it('dispatches chat.turn-start to onChatTurnStart', () => {
    const onChatTurnStart = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnStart })

    const frame = { type: 'chat.turn-start', turnId: 'turn-1', spaceId: 'spc-home' }
    deliver(socket, frame)

    expect(onChatTurnStart).toHaveBeenCalledWith(frame)
  })

  it('dispatches chat.turn-delta to onChatTurnDelta', () => {
    const onChatTurnDelta = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnDelta })

    const frame = { type: 'chat.turn-delta', turnId: 'turn-1', spaceId: 'spc-home', text: 'Hel' }
    deliver(socket, frame)

    expect(onChatTurnDelta).toHaveBeenCalledWith(frame)
  })

  it('dispatches chat.turn-replace to onChatTurnReplace', () => {
    const onChatTurnReplace = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnReplace })
    const frame = {
      type: 'chat.turn-replace',
      turnId: 'turn-1',
      spaceId: 'spc-home',
      message: {
        role: 'assistant',
        text: 'Awaiting your decision: Send message.',
        pendingDecisions: [
          {
            id: 'approval:effect-1',
            kind: 'approval',
            summary: 'Send message',
            scope: { type: 'space', spaceId: 'spc-home' },
            allowedResolutions: ['approve', 'reject'],
            state: 'pending',
            createdAt: '2026-08-25T10:00:00.000Z',
          },
        ],
      },
    }

    deliver(socket, frame)

    expect(onChatTurnReplace).toHaveBeenCalledWith(frame)
  })

  it('dispatches chat.turn-end to onChatTurnEnd, message intact', () => {
    const onChatTurnEnd = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnEnd })

    const frame = {
      type: 'chat.turn-end',
      turnId: 'turn-1',
      spaceId: 'spc-home',
      message: { role: 'assistant', text: 'the complete final answer' },
    }
    deliver(socket, frame)

    expect(onChatTurnEnd).toHaveBeenCalledWith(frame)
  })

  it('dispatches chat.turn-error to onChatTurnError', () => {
    const onChatTurnError = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnError })

    const frame = { type: 'chat.turn-error', turnId: 'turn-1', spaceId: 'spc-home', error: 'boom' }
    deliver(socket, frame)

    expect(onChatTurnError).toHaveBeenCalledWith(frame)
  })

  it('still dispatches chat.message to onChatMessage, unaffected by the new frame types', () => {
    const onChatMessage = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatMessage })

    const frame = { type: 'chat.message', message: { role: 'assistant', text: 'a system notice' } }
    deliver(socket, frame)

    expect(onChatMessage).toHaveBeenCalledWith(frame)
  })

  it('dispatches authoritative Pending-decision lifecycle frames intact', () => {
    const onPendingDecisionLifecycle = vi.fn()
    const { socket } = connectWithFakeSocket({ onPendingDecisionLifecycle })
    const frame = {
      type: 'pending-decision.lifecycle',
      revision: 3,
      message: 'In progress: Send message.',
      decision: {
        id: 'approval:effect-1',
        kind: 'approval',
        summary: 'Send message',
        scope: { type: 'global' },
        allowedResolutions: ['approve', 'reject'],
        state: 'resolving',
        createdAt: '2026-08-25T10:00:00.000Z',
        decisionAt: '2026-08-25T10:01:00.000Z',
        resolvedBy: 'trusted:user',
      },
    }

    deliver(socket, frame)

    expect(onPendingDecisionLifecycle).toHaveBeenCalledWith(frame)
  })

  it('dispatches Automation outcome notification lifecycle frames intact', () => {
    const onAutomationOutcomeNotificationLifecycle = vi.fn()
    const { socket } = connectWithFakeSocket({ onAutomationOutcomeNotificationLifecycle })
    const frame = {
      type: 'automation-outcome-notification.lifecycle',
      revision: 3,
      notification: {
        id: 'aon-1',
        revision: 3,
        spaceId: 'spc-health',
        spaceSlug: 'health',
        automationId: 12,
        surfaceId: 'srf-plan',
        kind: 'changed',
        title: 'Plan updated',
        summary: 'Two new entries',
        coalesceKey: 'entries',
        occurrenceCount: 1,
        state: 'unread',
        createdAt: '2026-09-02T08:00:00.000Z',
        updatedAt: '2026-09-02T08:00:00.000Z',
        href: '/app/space/health/surface/srf-plan',
      },
    }

    deliver(socket, frame)

    expect(onAutomationOutcomeNotificationLifecycle).toHaveBeenCalledWith(frame)
  })

  it('reports a malformed frame visibly without dispatching invalid domain data', () => {
    const onChatTurnDelta = vi.fn()
    const onError = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnDelta, onError })

    // Missing required `turnId`.
    deliver(socket, { type: 'chat.turn-delta', spaceId: 'spc-home', text: 'x' })

    expect(onChatTurnDelta).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      'Malformed Gateway frame; refreshing confirmed state.',
    )
  })
})

// hello clientId round-trip (issue 037): a reconnect must carry the
// clientId assigned by the previous connection so the daemon's GatewayHub
// re-binds the same session to the new socket instead of allocating a
// fresh one -- otherwise a turn's closing frame keeps addressing a
// clientId nothing is listening on anymore.
describe('connectGateway hello clientId', () => {
  it('omits clientId from the hello frame on a first connection', () => {
    const { socket } = connectWithFakeSocket({})
    socket.onopen?.()

    const sent = JSON.parse(socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(sent).toMatchObject({ type: 'hello', surfaceCursor: 0 })
    expect(sent).not.toHaveProperty('clientId')
  })

  it('sends the last-known clientId on the hello frame when the caller has one', () => {
    const { socket } = connectWithFakeSocket({ clientId: 'pwa-7' })
    socket.onopen?.()

    const sent = JSON.parse(socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>
    expect(sent).toMatchObject({ type: 'hello', clientId: 'pwa-7' })
  })

  it('passes the server-assigned clientId from the hello reply to onHello', () => {
    const onHello = vi.fn()
    const { socket } = connectWithFakeSocket({ onHello })

    deliver(socket, { type: 'hello', clientId: 'pwa-9', surfaceCursor: 3, replayed: 0 })

    expect(onHello).toHaveBeenCalledWith(3, 'pwa-9')
  })
})
