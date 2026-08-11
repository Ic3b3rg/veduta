import type { FastifyInstance } from 'fastify'
import { sendPwaAsset } from './static-assets.ts'

export function registerStaticRoutes(app: FastifyInstance, pwaDistDir: string): void {
  app.get('/', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))
  app.get('/app/*', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))
  app.get('/setup', (_request, reply) => sendPwaAsset(reply, pwaDistDir, 'index.html'))
  app.get('/manifest.webmanifest', (_request, reply) =>
    sendPwaAsset(reply, pwaDistDir, 'manifest.webmanifest'),
  )
  app.get('/service-worker.js', (_request, reply) =>
    sendPwaAsset(reply, pwaDistDir, 'service-worker.js'),
  )
  app.get('/assets/*', (request, reply) =>
    sendPwaAsset(reply, pwaDistDir, `assets/${wildcardPath(request.params)}`),
  )
  app.get('/icons/*', (request, reply) =>
    sendPwaAsset(reply, pwaDistDir, `icons/${wildcardPath(request.params)}`),
  )
}

function wildcardPath(params: unknown): string {
  return (params as { '*': string })['*']
}
