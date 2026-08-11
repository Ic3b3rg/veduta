import { PushSubscriptionSchema } from '@veduta/protocol'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { PushStore } from './push-store.ts'
import { extractBearer, type ServerAuthOptions } from './server-auth.ts'
import { isAllowedPushEndpoint, type VapidConfig } from './web-push-transport.ts'

const PushSubscriptionDeleteBodySchema = z.object({ endpoint: z.string().min(1) })

export function registerPushRoutes(
  app: FastifyInstance,
  deps: { auth: ServerAuthOptions; pushStore: PushStore; vapid: VapidConfig },
): void {
  const { auth, pushStore, vapid } = deps

  app.get('/api/push/vapid-public-key', () => ({ publicKey: vapid.publicKey }))

  app.post('/api/push/subscriptions', (request, reply) => {
    const parsed = PushSubscriptionSchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    if (!isAllowedPushEndpoint(parsed.data.endpoint)) {
      return reply
        .status(422)
        .send({ error: 'push subscription endpoint host is not on the allowed push-service list' })
    }
    const deviceId =
      auth.mode === 'production'
        ? auth.store.verifySession(extractBearer(request.headers.authorization))?.device.id
        : undefined
    pushStore.upsertSubscription({
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
      ...(deviceId === undefined ? {} : { deviceId }),
    })
    return reply.status(204).send()
  })

  app.delete('/api/push/subscriptions', (request, reply) => {
    const parsed = PushSubscriptionDeleteBodySchema.safeParse(request.body)
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
    if (auth.mode === 'production') {
      const deviceId = auth.store.verifySession(extractBearer(request.headers.authorization))
        ?.device.id
      const subscription = pushStore
        .listSubscriptions()
        .find((candidate) => candidate.endpoint === parsed.data.endpoint)
      if (subscription && subscription.deviceId !== deviceId) {
        return reply.status(403).send({ error: 'subscription does not belong to this device' })
      }
    }
    pushStore.deleteSubscription(parsed.data.endpoint)
    return reply.status(204).send()
  })
}
