import type { ImportPlan, ImportResult, OnboardingStatus, Surface } from '@veduta/protocol'
import { SurfaceSchema } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  connectGateway,
  errorMessageFromBody,
  expiresInLabel,
  fastActionIdempotencyKey,
  fetchOnboardingStatus,
  fetchSpaces,
  freshnessLabel,
  optimisticFastSurface,
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

describe('pinSurface', () => {
  it('posts { pinned } to /api/surfaces/:id/pin with the auth header and parses the returned Surface', async () => {
    const surface = buildSurface({ pinned: true })
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ surface }), { status: 200 })
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
    expect(result).toEqual(surface)
  })

  it('rejects with a readable message on a non-2xx response', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ error: 'Surface is not pinnable' }), { status: 409 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(pinSurface('srf-meals', true)).rejects.toThrow('Surface is not pinnable')
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
    onChatMessage: vi.fn(),
    onChatTurnStart: vi.fn(),
    onChatTurnDelta: vi.fn(),
    onChatTurnEnd: vi.fn(),
    onChatTurnError: vi.fn(),
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

  it('drops a frame that fails schema validation without calling any handler', () => {
    const onChatTurnDelta = vi.fn()
    const onError = vi.fn()
    const { socket } = connectWithFakeSocket({ onChatTurnDelta, onError })

    // Missing required `turnId`.
    deliver(socket, { type: 'chat.turn-delta', spaceId: 'spc-home', text: 'x' })

    expect(onChatTurnDelta).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
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
