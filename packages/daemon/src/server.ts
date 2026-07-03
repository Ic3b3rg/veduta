import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import { ActionInvocationSchema } from '@veduta/protocol'
import Fastify from 'fastify'
import { z } from 'zod'
import { mockReply, type ChatMessage } from './mock-provider.ts'
import { Store } from './store.ts'

const FastActionBodySchema = ActionInvocationSchema.extend({
  payload: z.object({ stateKey: z.string().min(1), value: z.unknown() }),
})

/**
 * The Gateway in scaffold form (issue #1): HTTP API + chat WebSocket
 * on loopback, dev profile only. TLS/passkeys are issue #5, the real
 * ChannelAdapter surface sync is issue #4.
 */
export function buildServer() {
  const app = Fastify({ logger: false })
  const store = new Store()

  void app.register(cors, { origin: true })
  void app.register(websocket)

  app.get('/api/health', () => ({ ok: true }))

  app.get('/api/spaces', () => {
    const spaces = store.listSpaces()
    return {
      spaces: spaces.map((space) => ({
        ...space,
        surfaces: store.listSurfaces(space.id),
      })),
    }
  })

  app.get('/api/spaces/:spaceId/events', (request) => {
    const { spaceId } = request.params as { spaceId: string }
    return { events: store.eventLog(spaceId) }
  })

  app.post('/api/surfaces/:surfaceId/actions', (request, reply) => {
    const { surfaceId } = request.params as { surfaceId: string }
    const parsed = FastActionBodySchema.safeParse(request.body)
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues })
    }
    if (!store.getSurface(surfaceId)) {
      return reply.status(404).send({ error: `unknown surface: ${surfaceId}` })
    }
    const { stateKey, value } = parsed.data.payload
    const surface = store.applyFastAction(surfaceId, stateKey, value)
    return { surface }
  })

  void app.register(async (instance) => {
    instance.get('/ws/chat', { websocket: true }, (socket) => {
      const history: ChatMessage[] = []
      socket.on('message', (raw: Buffer) => {
        const parsed = z.object({ text: z.string() }).safeParse(JSON.parse(raw.toString()))
        if (!parsed.success) return
        history.push({ role: 'user', text: parsed.data.text })
        const reply: ChatMessage = { role: 'assistant', text: mockReply(history) }
        history.push(reply)
        socket.send(JSON.stringify(reply))
      })
    })
  })

  return { app, store }
}
