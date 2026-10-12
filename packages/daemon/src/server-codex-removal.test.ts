import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CODEX_PINNED_VERSION } from './codex-app-server.ts'
import { saveConnectionsConfig } from './connections-config.ts'
import { buildServer } from './server.ts'

it.each(['initialize', 'model/list'])(
  'removes a real child during %s before erasing its home',
  async (heldMethod) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'veduta-codex-remove-'))
    const connectionId = 'aaaaaaaa-0000-4000-8000-000000000118'
    const codexHome = join(dataDir, 'codex', connectionId)
    mkdirSync(codexHome, { recursive: true })
    writeFileSync(join(codexHome, 'auth.json'), 'disposable-authorization')
    writeFileSync(
      join(codexHome, 'app-server'),
      `const fs = require('node:fs')
const readline = require('node:readline')
process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(join(dataDir, 'term-observed'))}, 'yes'))
const send = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  if (request.method === '${heldMethod}') {
    fs.writeFileSync('held', String(process.pid))
  } else if (request.method === 'initialize') {
    send(request.id, { userAgent: 'codex/${CODEX_PINNED_VERSION}', codexHome: process.cwd(), platformFamily: 'unix', platformOs: process.platform })
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
          label: 'Disposable',
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
      await vi.waitFor(() => expect(existsSync(join(codexHome, 'held'))).toBe(true), {
        timeout: 5_000,
      })
      childPid = Number(readFileSync(join(codexHome, 'held'), 'utf8'))
      await connections.remove(connectionId)
      expect(await outcome).toEqual([
        { status: 'rejected', reason: expect.objectContaining({ code: 'unreachable' }) },
      ])
      expect(() => process.kill(childPid!, 0)).toThrow()
      expect(existsSync(codexHome)).toBe(false)
      expect(existsSync(join(dataDir, 'term-observed'))).toBe(true)
      await expect(connections.catalog(connectionId)).rejects.toThrow('no such Model connection')
      expect(existsSync(codexHome)).toBe(false)
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL')
        } catch {
          /* Already reaped. */
        }
      }
      await app.close()
      vi.unstubAllEnvs()
      rmSync(dataDir, { recursive: true, force: true })
    }
  },
  15_000,
)

it('keeps unrelated Gateway routes available when a Codex home has an unsupported schema', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const dataDir = mkdtempSync(join(tmpdir(), 'veduta-codex-refusal-'))
  const id = 'aaaaaaaa-0000-4000-8000-000000000118'
  const home = join(dataDir, 'codex', id)
  mkdirSync(home, { recursive: true })
  const db = new DatabaseSync(join(home, 'state_5.sqlite'))
  db.exec(
    "CREATE TABLE future_history (content TEXT); INSERT INTO future_history VALUES ('retain-ambiguous')",
  )
  db.close()
  saveConnectionsConfig(dataDir, {
    version: 1,
    mockEnabled: false,
    connections: [
      {
        id,
        method: 'chatgpt-codex',
        provider: 'openai',
        label: 'Unsupported fixture',
        state: 'connected',
        stateAt: '2026-10-12T00:00:00.000Z',
        createdAt: '2026-10-12T00:00:00.000Z',
        enabledForFallback: false,
      },
    ],
  })
  const original = readFileSync(join(home, 'state_5.sqlite'))
  const { app, connections } = buildServer({ dataDir })
  try {
    expect((await app.inject({ method: 'GET', url: '/api/spaces' })).statusCode).toBe(200)
    await expect(connections.catalog(id)).rejects.toMatchObject({
      code: 'unreachable',
      message: expect.stringContaining('unsupported or unsafe layout'),
    })
    expect(readFileSync(join(home, 'state_5.sqlite'))).toEqual(original)
  } finally {
    await app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
