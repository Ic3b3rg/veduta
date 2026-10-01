import { expect, type Browser, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import { parseSpaceEventLine, type SpaceEvent } from '../../daemon/src/space-events.ts'
import {
  AuthSessionSchema,
  FastActionInvocationSchema,
  FastActionOutcomeSchema,
  GatewayServerMessageSchema,
  JsonObjectSchema,
  PairingCodeSchema,
  SurfaceSnapshotSchema,
  type CommittedFastActionMetadata,
  type CommittedFastActionOutcome,
  type FastActionInvocation,
  type FastActionOutcome,
  type Surface,
} from '../../protocol/src/index.ts'
import { ITEM_SURFACE_ID, MEASUREMENT_SURFACE_ID } from './fast-action-surfaces.ts'

export async function authenticatedHeaders(page: Page): Promise<{ authorization: string }> {
  const token = await page.evaluate(() => localStorage.getItem('veduta.authToken'))
  if (!token) throw new Error('Authenticated session is missing')
  return { authorization: `Bearer ${token}` }
}

/** A separate passkey and session exercise the same production device registration as the PWA. */
export async function pairActionObserver(browser: Browser, primary: Page, origin: string) {
  const pairingResponse = await primary.request.post(`${origin}/api/auth/pairing-codes`, {
    headers: await authenticatedHeaders(primary),
  })
  expect(pairingResponse.ok()).toBe(true)
  const pairing = PairingCodeSchema.parse(await pairingResponse.json())
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    const cdp = await context.newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2',
        transport: 'internal',
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    })
    await page.goto(origin)
    const registered = await page.evaluate(async (code) => {
      const optionsResponse = await fetch('/api/auth/register/options', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ oneTimeCode: code, deviceName: 'Fast Action observer' }),
      })
      const envelope = await optionsResponse.json()
      const publicKey = PublicKeyCredential.parseCreationOptionsFromJSON(envelope.options)
      const credential = await navigator.credentials.create({ publicKey })
      if (!(credential instanceof PublicKeyCredential))
        throw new Error('Observer passkey registration failed')
      const verified = await fetch('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ceremonyId: envelope.ceremonyId, response: credential.toJSON() }),
      })
      if (!verified.ok) throw new Error(`Observer registration failed: ${verified.status}`)
      return verified.json()
    }, pairing.code)
    const session = AuthSessionSchema.parse(registered)
    await page.evaluate((token) => localStorage.setItem('veduta.authToken', token), session.token)
    expect((await authenticatedHeaders(primary)).authorization).not.toBe(`Bearer ${session.token}`)
    return { context, page }
  } catch (error) {
    await context.close()
    throw error
  }
}

export function surfaceCard(page: Page, title: string) {
  return page.locator('article.surface-card', {
    has: page.getByRole('button', { name: `Focus ${title}`, exact: true }),
  })
}

export async function readSurface(page: Page, origin: string, surfaceId: string): Promise<Surface> {
  const response = await page.request.get(`${origin}/api/spaces`, {
    headers: await authenticatedHeaders(page),
  })
  expect(response.ok()).toBe(true)
  const snapshot = SurfaceSnapshotSchema.parse(await response.json())
  const surface = snapshot.spaces.flatMap((space) => space.surfaces).find((s) => s.id === surfaceId)
  if (!surface) throw new Error(`Surface ${surfaceId} is missing from the authenticated snapshot`)
  return surface
}

export async function readEvents(page: Page, origin: string): Promise<SpaceEvent[]> {
  const response = await page.request.get(`${origin}/api/spaces/spc-health/events`, {
    headers: await authenticatedHeaders(page),
  })
  expect(response.ok()).toBe(true)
  const body = JsonObjectSchema.parse(await response.json())
  if (!Array.isArray(body['events'])) throw new Error('Space Event log is missing')
  return body['events'].map((value) => {
    const event = parseSpaceEventLine(JSON.stringify(value))
    if (!event) throw new Error('Space Event log contains an invalid entry')
    return event
  })
}

export async function expectCommittedEvent(
  page: Page,
  origin: string,
  outcome: CommittedFastActionOutcome,
): Promise<void> {
  const events = (await readEvents(page, origin)).filter(
    (event) => event.payload?.['intentId'] === outcome.intentId,
  )
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    type: 'fast_path',
    at: outcome.surface.freshness.updatedAt,
    spaceId: outcome.surface.spaceId,
    origin: 'trusted:user',
    payload: {
      surfaceId: outcome.surfaceId,
      nodeId: outcome.nodeId,
      actionName: outcome.actionName,
      actionRevision: outcome.actionRevision,
      intentId: outcome.intentId,
      surfaceCommitId: outcome.surfaceCommitId,
      operations: outcome.patch.operations.length,
    },
  })
}

export function committedOutcome(outcome: FastActionOutcome): CommittedFastActionOutcome {
  if (outcome.outcome !== 'committed') throw new Error(`Action outcome is ${outcome.outcome}`)
  return outcome
}

export function latest<T>(values: readonly T[]): T {
  const value = values.at(-1)
  if (value === undefined) throw new Error('Expected a captured Action transport value')
  return value
}

export function records(surface: Surface, stateKey: string) {
  const values = surface.state[stateKey]
  if (!Array.isArray(values)) throw new Error(`Surface has no ${stateKey} collection`)
  return values.map((value) => JsonObjectSchema.parse(value))
}

type ActionRequest = { surfaceId: string; invocation: FastActionInvocation }
type ActionInterceptor = (route: Route, request: ActionRequest) => Promise<void>

/** Failure injection stays at browser transports; all durable writes still use the real Gateway. */
export class ActionWire {
  readonly requests: ActionRequest[] = []
  readonly outcomes: FastActionOutcome[] = []
  readonly delivered: CommittedFastActionMetadata[] = []
  holdPatches = false
  disconnected = false
  private socket: WebSocketRoute | undefined
  private held: (() => void)[] = []
  private next: ActionInterceptor | undefined

  constructor(
    private readonly page: Page,
    private readonly heldSurfaceIds: readonly string[] = [ITEM_SURFACE_ID, MEASUREMENT_SURFACE_ID],
  ) {}

  async install(): Promise<void> {
    await this.page.route('**/api/surfaces/*/actions', async (route) => {
      const surfaceId = route.request().url().split('/').at(-2)
      if (!surfaceId) throw new Error('Action request has no Surface identity')
      const request = {
        surfaceId,
        invocation: FastActionInvocationSchema.parse(route.request().postDataJSON()),
      }
      this.requests.push(request)
      const intercept = this.next
      this.next = undefined
      if (intercept) await intercept(route, request)
      else await this.deliverHttp(route)
    })
    await this.page.routeWebSocket('**/ws/gateway', (socket) => {
      if (this.disconnected) {
        void socket.close()
        return
      }
      this.socket = socket
      const server = socket.connectToServer()
      server.onMessage((message) => {
        const frame = GatewayServerMessageSchema.parse(JSON.parse(message.toString()))
        const outcome = frame.type === 'surface.patch' ? frame.event.actionOutcome : undefined
        const fixture =
          frame.type === 'surface.patch' &&
          this.heldSurfaceIds.includes(frame.event.patch.surfaceId)
        const send = () => {
          if (outcome) this.delivered.push(outcome)
          socket.send(message)
        }
        if (this.holdPatches && fixture) this.held.push(send)
        else send()
      })
    })
  }

  interceptNext(intercept: ActionInterceptor): void {
    if (this.next) throw new Error('An Action transport interception is already pending')
    this.next = intercept
  }

  async deliverHttp(route: Route): Promise<FastActionOutcome> {
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    const outcome = FastActionOutcomeSchema.parse(await response.json())
    this.outcomes.push(outcome)
    await route.fulfill({ response })
    return outcome
  }

  async outcomeFor(intentId: string, duplicate = false): Promise<FastActionOutcome> {
    const find = () =>
      this.outcomes.find(
        (outcome) => outcome.intentId === intentId && outcome.duplicate === duplicate,
      )
    await expect.poll(find).toBeTruthy()
    const outcome = find()
    if (!outcome) throw new Error(`Action ${intentId} has no captured HTTP outcome`)
    return outcome
  }

  releasePatches(): void {
    this.holdPatches = false
    const held = this.held
    this.held = []
    for (const send of held) send()
  }

  dropPatches(): void {
    this.held = []
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
    await this.socket?.close()
  }
}

export function signal<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
