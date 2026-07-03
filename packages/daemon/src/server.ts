import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { fileURLToPath } from 'node:url'
import { ActionInvocationSchema, JsonValueSchema, findDeclaredFastAction } from '@veduta/protocol'
import Fastify from 'fastify'
import { z } from 'zod'
import { GatewayHub } from './gateway.ts'
import { sendPwaAsset } from './static-assets.ts'
import { Store } from './store.ts'

// The client sends only (nodeId, action name, value): the state key comes
// from the Atom's declared action, never from the client (ADR-0003).
const FastActionBodySchema = ActionInvocationSchema.extend({
  payload: z.object({ value: JsonValueSchema }),
})

export interface ServerOptions {
  pwaDistDir?: string
}

const defaultPwaDistDir = fileURLToPath(new URL('../../pwa/dist/', import.meta.url))

/**
 * The Gateway in scaffold form (issue #1): HTTP API + chat WebSocket
 * on loopback, dev profile only. TLS/passkeys are issue #5, the real
 * ChannelAdapter surface sync is issue #4.
 */
export function buildServer(options: ServerOptions = {}) {
  const app = Fastify({ logger: false })
  const store = new Store()
  const gateway = new GatewayHub(store)
  const pwaDistDir = options.pwaDistDir ?? defaultPwaDistDir

  // Dev profile: only the Vite dev server may call the daemon from a browser.
  void app.register(cors, {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  })
  void app.register(websocket)

  app.get('/api/health', () => ({ ok: true }))

  app.get('/', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))

  app.get('/assets/*', (request, reply) => {
    const asset = (request.params as { '*': string })['*']
    return sendPwaAsset(reply, pwaDistDir, `assets/${asset}`)
  })

  app.get('/api/spaces', () => {
    return store.snapshot()
  })

  app.get('/api/spaces/:spaceId/events', (request, reply) => {
    const { spaceId } = request.params as { spaceId: string }
    if (!store.getSpace(spaceId)) {
      return reply.status(404).send({ error: `unknown space: ${spaceId}` })
    }
    return { events: store.eventLog(spaceId) }
  })

  app.post('/api/surfaces/:surfaceId/actions', (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = FastActionBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues })
    }
    const target = store.getSurface(surfaceId)
    if (!target) {
      return reply.status(404).send({ error: `unknown surface: ${surfaceId}` })
    }
    const declared = findDeclaredFastAction(target.tree, parsed.data.nodeId, parsed.data.name)
    if (!declared) {
      return reply.status(403).send({
        error: `action "${parsed.data.name}" is not declared as fast by node "${parsed.data.nodeId}"`,
      })
    }
    const mutation = store.applyFastAction(surfaceId, declared.stateKey, parsed.data.payload.value)
    gateway.broadcastSurfacePatch(mutation.event)
    return { surface: mutation.surface }
  })

  void app.register(async (instance) => {
    instance.get('/ws/gateway', { websocket: true }, (socket) => {
      gateway.connect(socket)
    })
  })

  return { app, store, gateway }
}
