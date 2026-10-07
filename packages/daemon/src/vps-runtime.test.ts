import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const children: ChildProcess[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
  }
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no TCP listener')
  const port = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
  return port
}

it('serves Tunnel access with production auth and keeps bootstrap state across restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'veduta-tunnel-runtime-'))
  dirs.push(dataDir)
  const port = await freePort()
  const origin = `http://localhost:${port}`
  async function boot() {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: join(root, 'packages/daemon'),
      env: {
        ...process.env,
        VEDUTA_PROFILE: 'vps',
        VEDUTA_ACCESS: 'tunnel',
        VEDUTA_PUBLIC_DOMAIN: '',
        VEDUTA_DATA_DIR: dataDir,
        VEDUTA_AUTH_STATE: join(dataDir, 'auth.json'),
        PORT: String(port),
        VEDUTA_BOOTSTRAP_CODE: 'tunnel-test-bootstrap',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout?.on('data', (data: Buffer) => {
      output += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      output += data.toString()
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Gateway did not boot: ${output}`))
      }, 15000)
      const inspect = () => {
        if (output.includes('veduta daemon (production profile)')) {
          clearTimeout(timer)
          resolve()
        }
      }
      child.stdout?.on('data', inspect)
      child.once('exit', () => {
        clearTimeout(timer)
        reject(new Error(`Gateway exited: ${output}`))
      })
    })
    return child
  }
  let child = await boot()
  for (let attempt = 0; attempt < 2; attempt++) {
    const status = await fetch(`http://127.0.0.1:${port}/api/auth/status`).then((r) => r.json())
    expect(status).toEqual({
      mode: 'production',
      passkeyRegistered: false,
      bootstrapRequired: true,
    })
    expect((await fetch(`http://127.0.0.1:${port}/api/spaces`)).status).toBe(401)
    const options = await fetch(`${origin}/api/auth/register/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ oneTimeCode: 'tunnel-test-bootstrap', deviceName: 'Test computer' }),
    })
    expect(options.status).toBe(200)
    expect(await options.json()).toMatchObject({ options: { rp: { id: 'localhost' } } })
    if (attempt === 0) {
      child.kill('SIGTERM')
      await once(child, 'exit')
      child = await boot()
    }
  }
}, 40000)
