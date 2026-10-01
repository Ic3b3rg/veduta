import { expect, type Page, type Route, type WebSocketRoute } from '@playwright/test'
import {
  AgentActionInvocationSchema,
  AgentActionResultSchema,
  GatewayServerMessageSchema,
  type AgentActionInvocation,
  type AgentActionTurn,
  type GatewayServerMessage,
} from '../../protocol/src/index.ts'
import { AGENT_ACTION_SURFACE_ID } from './agent-action-surface.ts'

type ActionRequest = { surfaceId: string; invocation: AgentActionInvocation }
type ActionInterceptor = (route: Route, request: ActionRequest) => Promise<void>

/** Failures are injected at browser transports; the existing Agent loop owns every effect. */
export class AgentActionWire {
  readonly requests: ActionRequest[] = []
  readonly outcomes: AgentActionTurn[] = []
  readonly frames: GatewayServerMessage[] = []
  holdUpdates = false
  disconnected = false
  private socket: WebSocketRoute | undefined
  private held: (() => void)[] = []
  private next: ActionInterceptor | undefined

  constructor(private readonly page: Page) {}

  async install(): Promise<void> {
    await this.page.route('**/api/surfaces/*/actions', async (route) => {
      const surfaceId = route.request().url().split('/').at(-2)
      if (surfaceId !== AGENT_ACTION_SURFACE_ID) {
        await route.continue()
        return
      }
      const request = {
        surfaceId,
        invocation: AgentActionInvocationSchema.parse(route.request().postDataJSON()),
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
        this.frames.push(frame)
        const fixture =
          (frame.type === 'surface.patch' &&
            frame.event.patch.surfaceId === AGENT_ACTION_SURFACE_ID) ||
          (frame.type === 'surface.action-turn' && frame.turn.surfaceId === AGENT_ACTION_SURFACE_ID)
        const send = () => socket.send(message)
        if (this.holdUpdates && fixture) this.held.push(send)
        else send()
      })
    })
  }

  interceptNext(intercept: ActionInterceptor): void {
    if (this.next) throw new Error('An Agent action interception is already pending')
    this.next = intercept
  }

  async captureHttp(
    route: Route,
  ): Promise<{ response: Awaited<ReturnType<Route['fetch']>>; turn: AgentActionTurn }> {
    const response = await route.fetch()
    expect(response.status()).toBe(200)
    const { turn } = AgentActionResultSchema.parse(await response.json())
    this.outcomes.push(turn)
    return { response, turn }
  }

  async deliverHttp(route: Route): Promise<AgentActionTurn> {
    const { response, turn } = await this.captureHttp(route)
    await route.fulfill({ response })
    return turn
  }

  async outcomeFor(idempotencyKey: string | undefined): Promise<AgentActionTurn> {
    const find = () => this.outcomes.find((turn) => turn.idempotencyKey === idempotencyKey)
    await expect.poll(find).toBeTruthy()
    const outcome = find()
    if (!outcome) throw new Error('Agent action has no captured terminal response')
    return outcome
  }

  releaseUpdates(): void {
    this.holdUpdates = false
    const held = this.held
    this.held = []
    for (const send of held) send()
  }

  async disconnect(): Promise<void> {
    this.disconnected = true
    this.held = []
    await this.socket?.close()
  }
}
