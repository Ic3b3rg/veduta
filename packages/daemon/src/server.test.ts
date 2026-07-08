import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  GatewayServerMessageSchema,
  SurfaceSchema,
  type GatewayServerMessage,
  type Surface,
} from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { AuthStore, type PasskeyRelyingParty, type StoredPasskey } from './auth-store.ts'
import { buildServer } from './server.ts'

describe('PWA static assets', () => {
  it('serves the built PWA index and assets without allowing path traversal', async () => {
    const pwaDistDir = await mkdtemp(join(tmpdir(), 'veduta-pwa-'))
    await mkdir(join(pwaDistDir, 'assets'))
    await mkdir(join(pwaDistDir, 'icons'))
    await writeFile(join(pwaDistDir, 'index.html'), '<div id="root"></div>')
    await writeFile(join(pwaDistDir, 'assets', 'app.js'), 'console.log("veduta")')
    await writeFile(join(pwaDistDir, 'manifest.webmanifest'), '{"name":"Veduta"}')
    await writeFile(join(pwaDistDir, 'service-worker.js'), 'self.addEventListener("fetch",()=>{})')
    await writeFile(join(pwaDistDir, 'icons', 'icon-192.svg'), '<svg></svg>')
    const { app } = buildServer({ pwaDistDir })

    const index = await app.inject({ method: 'GET', url: '/' })
    expect(index.statusCode).toBe(200)
    expect(index.headers['content-type']).toContain('text/html')
    expect(index.body).toContain('root')

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(asset.statusCode).toBe(200)
    expect(asset.headers['content-type']).toContain('text/javascript')

    const deepLink = await app.inject({
      method: 'GET',
      url: '/app/space/health/surface/srf-meals',
    })
    expect(deepLink.statusCode).toBe(200)
    expect(deepLink.headers['content-type']).toContain('text/html')

    const manifest = await app.inject({ method: 'GET', url: '/manifest.webmanifest' })
    expect(manifest.statusCode).toBe(200)
    expect(manifest.headers['content-type']).toContain('application/manifest+json')

    const serviceWorker = await app.inject({ method: 'GET', url: '/service-worker.js' })
    expect(serviceWorker.statusCode).toBe(200)
    expect(serviceWorker.headers['content-type']).toContain('text/javascript')

    const icon = await app.inject({ method: 'GET', url: '/icons/icon-192.svg' })
    expect(icon.statusCode).toBe(200)
    expect(icon.headers['content-type']).toContain('image/svg+xml')

    const traversal = await app.inject({ method: 'GET', url: '/assets/../index.html' })
    expect(traversal.statusCode).toBe(404)
  })
})

describe('GET /api/spaces', () => {
  it('returns the seed space with protocol-valid surfaces', async () => {
    const { app } = buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/spaces' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as {
      surfaceCursor: number
      spaces: { slug: string; surfaces: unknown[] }[]
    }
    expect(body.surfaceCursor).toBe(0)
    expect(body.spaces.map((s) => s.slug)).toEqual(['health', 'system'])
    for (const surface of body.spaces.flatMap((space) => space.surfaces)) {
      expect(SurfaceSchema.safeParse(surface).success).toBe(true)
    }
  })

  it('exposes the model usage Surface in the System space (BYOK transparency)', async () => {
    const { app, router } = buildServer()
    router.recordSpend({ provider: 'anthropic', modelId: 'claude-sonnet-5', tier: 'reasoning' }, 2)

    const res = await app.inject({ method: 'GET', url: '/api/spaces' })
    const body = res.json() as {
      spaces: { slug: string; surfaces: { id: string; tree: unknown }[] }[]
    }
    const system = body.spaces.find((space) => space.slug === 'system')
    const usage = system?.surfaces.find((surface) => surface.id === 'srf-usage')
    expect(usage).toBeDefined()
    expect(JSON.stringify(usage?.tree)).toContain('$2.00')
  })
})

describe('production auth boundary', () => {
  it('keeps PWA assets public but requires passkey sessions for application API routes', async () => {
    const pwaDistDir = await mkdtemp(join(tmpdir(), 'veduta-pwa-'))
    await mkdir(join(pwaDistDir, 'assets'))
    await mkdir(join(pwaDistDir, 'icons'))
    await writeFile(join(pwaDistDir, 'index.html'), '<div id="root"></div>')
    await writeFile(join(pwaDistDir, 'assets', 'app.js'), 'console.log("veduta")')
    await writeFile(join(pwaDistDir, 'manifest.webmanifest'), '{"name":"Veduta"}')
    await writeFile(join(pwaDistDir, 'service-worker.js'), 'self.addEventListener("fetch",()=>{})')
    await writeFile(join(pwaDistDir, 'icons', 'icon-192.svg'), '<svg></svg>')
    const { auth, token } = await readyAuthStore()
    const { app } = buildServer({
      pwaDistDir,
      auth: { mode: 'production', store: auth, allowedOrigins: ['https://veduta.test'] },
    })

    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/service-worker.js' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/icons/icon-192.svg' })).statusCode).toBe(200)
    expect(
      (await app.inject({ method: 'GET', url: '/app/space/health/surface/srf-meals' })).statusCode,
    ).toBe(200)

    const denied = await app.inject({ method: 'GET', url: '/api/spaces' })
    expect(denied.statusCode).toBe(401)
    expect(denied.headers['strict-transport-security']).toContain('max-age=')

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/spaces',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(allowed.statusCode).toBe(200)
    expect((allowed.json() as { spaces: { slug: string }[] }).spaces.map((s) => s.slug)).toEqual([
      'health',
      'system',
    ])
  })

  it('runs the passkey registration ceremony through public auth endpoints', async () => {
    const auth = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys: new ServerFakePasskeys(),
      now: fixedNow,
      randomBytes: deterministicBytes,
      publicOrigin: 'https://veduta.test',
    })
    const { app } = buildServer({
      auth: { mode: 'production', store: auth, allowedOrigins: ['https://veduta.test'] },
    })

    const options = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: { oneTimeCode: '12345678', deviceName: 'Silvio iPhone' },
    })
    expect(options.statusCode).toBe(200)
    const ceremony = options.json() as { ceremonyId: string; options: { challenge: string } }
    expect(ceremony.options.challenge).toBe('registration-challenge-1')

    const verified = await app.inject({
      method: 'POST',
      url: '/api/auth/register/verify',
      payload: { ceremonyId: ceremony.ceremonyId, response: { id: 'credential-phone' } },
    })
    expect(verified.statusCode).toBe(200)
    expect(verified.json()).toMatchObject({
      device: { name: 'Silvio iPhone', credentialId: 'credential-phone' },
    })
  })

  it('rate limits repeated invalid auth attempts with progressive lockout', async () => {
    const auth = new AuthStore({
      mode: 'production',
      bootstrapCode: '12345678',
      passkeys: new ServerFakePasskeys(),
      now: fixedNow,
      randomBytes: deterministicBytes,
    })
    const { app } = buildServer({
      auth: { mode: 'production', store: auth, allowedOrigins: ['https://veduta.test'] },
    })

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register/options',
        payload: { oneTimeCode: 'wrong-code', deviceName: 'Attacker' },
      })
      expect(res.statusCode).toBe(401)
    }

    const locked = await app.inject({
      method: 'POST',
      url: '/api/auth/register/options',
      payload: { oneTimeCode: 'wrong-code', deviceName: 'Attacker' },
    })
    expect(locked.statusCode).toBe(429)
    expect(locked.headers['retry-after']).toBeDefined()
  })

  it('creates pairing codes and lists linked devices only for authenticated sessions', async () => {
    const { auth, token } = await readyAuthStore()
    const { app } = buildServer({
      auth: { mode: 'production', store: auth, allowedOrigins: ['https://veduta.test'] },
    })

    expect((await app.inject({ method: 'GET', url: '/api/auth/devices' })).statusCode).toBe(401)

    const pairing = await app.inject({
      method: 'POST',
      url: '/api/auth/pairing-codes',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(pairing.statusCode).toBe(200)
    expect(pairing.json()).toMatchObject({
      pairingUri: 'https://veduta.test/setup?code=BwcHBwcHBwcH',
    })

    const devices = await app.inject({
      method: 'GET',
      url: '/api/auth/devices',
      headers: { authorization: `Bearer ${token}` },
    })
    expect(devices.statusCode).toBe(200)
    expect(devices.json()).toMatchObject({ devices: [{ name: 'Silvio iPhone' }] })
  })
})

describe('GET /api/spaces/:id/events', () => {
  it('returns 404 for an unknown space instead of an empty list', async () => {
    const { app } = buildServer()
    const res = await app.inject({ method: 'GET', url: '/api/spaces/spc-ghost/events' })
    expect(res.statusCode).toBe(404)
  })
})

describe('POST /api/surfaces/:id/actions (fast path)', () => {
  it('mutates the declared stateKey, stamps freshness and logs the event — no LLM involved', async () => {
    const { app, store } = buildServer()
    expect(store.llmCallCount()).toBe(0)
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-groceries/actions',
      payload: { nodeId: 'item-milk', name: 'toggle', payload: { value: true } },
    })
    expect(res.statusCode).toBe(200)
    const { surface } = res.json() as { surface: { state: Record<string, unknown> } }
    expect(surface.state['milk']).toBe(true)
    const events = store.eventLog('spc-health')
    expect(events.at(-1)?.text).toContain('milk')
    expect(store.surfaceEventsAfter(0)).toMatchObject([
      {
        cursor: 1,
        patch: {
          surfaceId: 'srf-groceries',
          operations: [{ target: 'state', op: 'replace', path: '/milk', value: true }],
        },
      },
    ])
    expect(store.llmCallCount()).toBe(0)
  })

  it('rejects an action the node does not declare as fast (403)', async () => {
    const { app } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-groceries/actions',
      payload: { nodeId: 'item-milk', name: 'delete-everything', payload: { value: true } },
    })
    expect(res.statusCode).toBe(403)
  })

  it('rejects an invocation aimed at a node without fast actions (403)', async () => {
    const { app, store } = buildServer()
    const before = store.getSurface('srf-goal')!.state
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-goal/actions',
      payload: { nodeId: 'current', name: 'toggle', payload: { value: 0 } },
    })
    expect(res.statusCode).toBe(403)
    expect(store.getSurface('srf-goal')!.state).toEqual(before)
  })

  it('rejects a malformed invocation with 400', async () => {
    const { app } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-groceries/actions',
      payload: fromPartial({ nodeId: 'item-milk' }),
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 404 for an unknown surface', async () => {
    const { app } = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-nope/actions',
      payload: { nodeId: 'x', name: 'toggle', payload: { value: 1 } },
    })
    expect(res.statusCode).toBe(404)
  })

  it('queues an Agent turn for declared agent-path actions', async () => {
    const { app, store } = buildServer()
    store.createSurface(agentActionSurface(), 'agent')

    const res = await app.inject({
      method: 'POST',
      url: '/api/surfaces/srf-agent-action/actions',
      payload: { nodeId: 'regenerate', name: 'regenerate_plan', payload: { reason: 'stale' } },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({
      turn: {
        surfaceId: 'srf-agent-action',
        atomId: 'regenerate',
        actionName: 'regenerate_plan',
        payload: { reason: 'stale' },
      },
    })
    expect(store.agentTurns().at(-1)).toMatchObject({
      surfaceId: 'srf-agent-action',
      atomId: 'regenerate',
      actionName: 'regenerate_plan',
    })
    expect(
      store.surfaceEventsAfter(0).filter((event) => event.patch.surfaceId === 'srf-agent-action'),
    ).toHaveLength(0)
  })
})

describe('scheduler wiring (issue #11)', () => {
  it('pre-creates the Automations Surface, arms a timer from dev chat and escalates on fire', async () => {
    let clock = new Date('2026-07-08T08:00:00.000Z')
    clock.setHours(13, 0, 0, 0) // parser and clock work in daemon-local time
    const { app, gateway, scheduler, store } = buildServer({
      now: () => new Date(clock.getTime()),
    })

    const snapshot = await app.inject({ method: 'GET', url: '/api/spaces' })
    const health = (
      snapshot.json() as { spaces: { id: string; surfaces: { id: string }[] }[] }
    ).spaces.find((space) => space.id === 'spc-health')
    expect(health?.surfaces.some((surface) => surface.id === 'srf-health-automations')).toBe(true)

    const socket = new SchedulerFakeSocket()
    gateway.connect(socket)
    socket.receive({ type: 'hello', surfaceCursor: store.latestSurfaceCursor() })
    socket.receive({
      type: 'chat.send',
      text: 'Remind me to log my weight by 9pm',
      spaceId: 'spc-health',
    })

    const automations = scheduler.listAutomations('spc-health')
    expect(automations).toHaveLength(1)
    expect(automations[0]).toMatchObject({
      description: 'log my weight',
      status: 'armed',
      condition: { kind: 'event-logged', textIncludes: 'weight' },
    })
    // The timer landed in the Surface as a live patch, visible and toggleable.
    expect(
      socket.sent.some(
        (frame) =>
          frame.type === 'surface.patch' &&
          frame.event.patch.surfaceId === 'srf-health-automations',
      ),
    ).toBe(true)

    clock = new Date(automations[0]!.nextRunAt!)
    await scheduler.runDue()
    expect(
      socket.sent.some(
        (frame) =>
          frame.type === 'chat.message' && frame.message.text === 'Reminder: log my weight',
      ),
    ).toBe(true)

    await app.close() // onClose stops the scheduler loop
  })
})

class SchedulerFakeSocket {
  readonly sent: GatewayServerMessage[] = []
  private readonly handlers = new Map<string, (raw: Buffer | string) => void>()

  send(data: string): void {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(data)))
  }

  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void): void {
    this.handlers.set(event, handler)
  }

  receive(frame: unknown): void {
    this.handlers.get('message')?.(JSON.stringify(frame))
  }
}

class ServerFakePasskeys implements PasskeyRelyingParty {
  private registrationCount = 0
  private authenticationCount = 0

  async generateRegistrationOptions(): Promise<{ challenge: string }> {
    this.registrationCount += 1
    return { challenge: `registration-challenge-${this.registrationCount}` }
  }

  async verifyRegistrationResponse(input: {
    response: unknown
  }): Promise<{ verified: true; passkey: StoredPasskey }> {
    const credentialId = (input.response as { id?: string }).id ?? 'credential-phone'
    return {
      verified: true,
      passkey: {
        id: credentialId,
        publicKey: `public-key-${credentialId}`,
        counter: 1,
        transports: ['internal'],
        deviceType: 'multiDevice',
        backedUp: true,
        webAuthnUserID: `user-${credentialId}`,
      },
    }
  }

  async generateAuthenticationOptions(): Promise<{ challenge: string }> {
    this.authenticationCount += 1
    return { challenge: `authentication-challenge-${this.authenticationCount}` }
  }

  async verifyAuthenticationResponse(input: {
    response: unknown
  }): Promise<{ verified: true; credentialId: string; newCounter: number }> {
    return {
      verified: true,
      credentialId: (input.response as { id?: string }).id ?? 'credential-phone',
      newCounter: 2,
    }
  }
}

async function readyAuthStore(): Promise<{ auth: AuthStore; token: string }> {
  const auth = new AuthStore({
    mode: 'production',
    bootstrapCode: '12345678',
    passkeys: new ServerFakePasskeys(),
    now: fixedNow,
    randomBytes: deterministicBytes,
    publicOrigin: 'https://veduta.test',
  })
  const registration = await auth.startPasskeyRegistration({
    oneTimeCode: '12345678',
    deviceName: 'Silvio iPhone',
  })
  const session = await auth.finishPasskeyRegistration({
    ceremonyId: registration.ceremonyId,
    response: { id: 'credential-phone' },
  })
  return { auth, token: session.token }
}

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}

function deterministicBytes(length: number): Buffer {
  return Buffer.alloc(length, 7)
}

function agentActionSurface(): Surface {
  return SurfaceSchema.parse({
    id: 'srf-agent-action',
    spaceId: 'spc-health',
    title: 'Agent action',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'regenerate',
          type: 'Button',
          props: { label: 'Regenerate' },
          actions: [{ name: 'regenerate_plan', path: 'agent' }],
        },
      ],
    },
    state: {},
    freshness: { updatedAt: fixedNow().toISOString(), updatedBy: 'seed' },
  })
}
