import type { FastifyInstance } from 'fastify'
import type { GatewayHub } from './gateway.ts'
import { isAllowedOrigin, type ServerAuthOptions } from './server-auth.ts'

export function registerGatewayRoute(
  app: FastifyInstance,
  deps: { auth: ServerAuthOptions; gateway: GatewayHub },
): void {
  void app.register(async (instance) => {
    instance.get('/ws/gateway', { websocket: true }, (socket, request) => {
      if (
        deps.auth.mode === 'production' &&
        !isAllowedOrigin(request.headers.origin, deps.auth.allowedOrigins)
      ) {
        socket.close()
        return
      }
      deps.gateway.connect(socket)
    })
  })
}
