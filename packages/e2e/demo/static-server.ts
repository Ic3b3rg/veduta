import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const prefix = '/veduta/'
const directory = new URL('../../website/dist/', import.meta.url)
const types: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  css: 'text/css',
  png: 'image/png',
  gif: 'image/gif',
  mp4: 'video/mp4',
  vtt: 'text/vtt',
  woff2: 'font/woff2',
}
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  const path = pathname.slice(prefix.length) || 'index.html'
  if (!pathname.startsWith(prefix) || path.includes('..')) {
    response.writeHead(404).end()
    return
  }
  try {
    const body = await readFile(fileURLToPath(new URL(path, directory)))
    response
      .writeHead(200, {
        'Content-Type': types[path.split('.').at(-1)!] ?? 'application/octet-stream',
        'Content-Security-Policy':
          "default-src 'self'; connect-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      })
      .end(body)
  } catch {
    response.writeHead(404).end()
  }
})
server.listen(5191, '127.0.0.1')
process.once('SIGTERM', () => server.close())
