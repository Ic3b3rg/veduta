import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import type { FastifyReply } from 'fastify'

export async function sendPwaAsset(
  reply: FastifyReply,
  pwaDistDir: string,
  assetPath: string,
): Promise<FastifyReply> {
  const target = resolve(pwaDistDir, assetPath)
  const relativePath = relative(pwaDistDir, target)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return reply.status(404).send({ error: 'asset not found' })
  }

  try {
    const file = await readFile(target)
    return reply.type(contentType(target)).send(file)
  } catch {
    return reply.status(404).send({ error: 'asset not found' })
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.webmanifest':
      return 'application/manifest+json'
    default:
      return 'application/octet-stream'
  }
}
