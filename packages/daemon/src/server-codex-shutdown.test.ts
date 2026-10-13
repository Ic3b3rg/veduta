import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CODEX_PINNED_VERSION } from './codex-app-server.ts'
import { saveConnectionsConfig } from './connections-config.ts'
import { buildServer } from './server.ts'

it('Gateway shutdown closes a Codex child whose initialization finishes after app.close', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'veduta-codex-shutdown-'))
  const connectionId = 'aaaaaaaa-0000-4000-8000-000000000207'
  const codexHome = join(dataDir, 'codex', connectionId)
  mkdirSync(codexHome, { recursive: true })
  // Node executes this local fake as `app-server` from the real transport's cwd.
  // A file gate holds its initialize response across the owning Gateway's close.
  writeFileSync(
    join(codexHome, 'app-server'),
    `const fs = require('node:fs')
const readline = require('node:readline')
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === 'initialize') {
    fs.writeFileSync('initializing', String(process.pid))
    const timer = setInterval(() => {
      if (!fs.existsSync('release')) return
      clearInterval(timer)
      send(request.id, { userAgent: 'codex/${CODEX_PINNED_VERSION}', codexHome: process.cwd(), platformFamily: 'unix', platformOs: process.platform })
    }, 10)
  } else if (request.method === 'model/list') {
    fs.writeFileSync('catalog-called', '')
    send(request.id, { data: [], nextCursor: null })
  }
})
`,
  )
  saveConnectionsConfig(dataDir, {
    version: 1,
    mockEnabled: false,
    connections: [
      {
        id: connectionId,
        method: 'chatgpt-codex',
        provider: 'openai',
        label: 'Disposable fake',
        state: 'connected',
        stateAt: '2026-10-12T00:00:00.000Z',
        createdAt: '2026-10-12T00:00:00.000Z',
        enabledForFallback: false,
      },
    ],
  })
  vi.stubEnv('VEDUTA_CODEX_BIN', process.execPath)
  const { app, connections } = buildServer({ dataDir })
  let childPid: number | undefined
  try {
    await app.listen({ host: '127.0.0.1', port: 0 })
    const outcome = Promise.allSettled([connections.catalog(connectionId)])
    await vi.waitFor(() => expect(existsSync(join(codexHome, 'initializing'))).toBe(true), {
      timeout: 5_000,
    })
    childPid = Number(readFileSync(join(codexHome, 'initializing'), 'utf8'))

    await app.close()
    writeFileSync(join(codexHome, 'release'), '')

    expect(await outcome).toEqual([
      { status: 'rejected', reason: expect.objectContaining({ code: 'unreachable' }) },
    ])
    await vi.waitFor(() => expect(() => process.kill(childPid!, 0)).toThrow())
    expect(existsSync(join(codexHome, 'catalog-called'))).toBe(false)
  } finally {
    if (childPid === undefined && existsSync(join(codexHome, 'initializing'))) {
      childPid = Number(readFileSync(join(codexHome, 'initializing'), 'utf8'))
    }
    if (childPid !== undefined) {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // The expected path already reaped the disposable child.
      }
    }
    await app.close()
    vi.unstubAllEnvs()
    rmSync(dataDir, { recursive: true, force: true })
  }
}, 20_000)
