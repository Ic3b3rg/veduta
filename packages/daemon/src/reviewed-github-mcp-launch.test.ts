import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { reviewedGithubMcpLaunch } from './reviewed-github-mcp-launch.ts'

async function listener(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test TCP port')
  return { server, port: address.port }
}

it.skipIf(process.platform !== 'darwin')(
  'permits the executable and relay TCP while denying private metadata/content, writes and other TCP',
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'veduta-mcp-boundary-')))
    const homeRoot = mkdtempSync(join(homedir(), '.veduta-mcp-boundary-'))
    const binary = join(root, 'reviewed-mcp', 'test', 'probe')
    const privateFile = join(root, 'private-canary')
    const homeFile = join(homeRoot, 'private-canary')
    const proxy = await listener()
    const denied = await listener()
    try {
      mkdirSync(dirname(binary), { recursive: true })
      writeFileSync(binary, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 })
      writeFileSync(privateFile, 'Gateway private data')
      writeFileSync(homeFile, 'Home private data')
      const script = `
        const fs = require('node:fs'), net = require('node:net');
        const attempt = (fn) => { try { fn(); return true } catch { return false } };
        const connect = (port) => new Promise((resolve) => {
          const socket = net.connect({host: '127.0.0.1', port});
          socket.setTimeout(1000);
          const done = (ok) => {socket.destroy(); resolve(ok)};
          socket.on('connect', () => done(true));
          socket.on('error', () => done(false));
          socket.on('timeout', () => done(false));
        });
        (async () => console.log(JSON.stringify({
          metadata: attempt(() => fs.statSync(${JSON.stringify(dirname(binary))})),
          binary: attempt(() => fs.readFileSync(${JSON.stringify(binary)})),
          private: attempt(() => fs.readFileSync(${JSON.stringify(privateFile)})),
          home: attempt(() => fs.readFileSync(${JSON.stringify(homeFile)})),
          directory: attempt(() => fs.readdirSync(${JSON.stringify(root)})),
          write: attempt(() => fs.writeFileSync(${JSON.stringify(join(root, 'write-canary'))}, 'x')),
          proxy: await connect(${proxy.port}),
          other: await connect(${denied.port}),
        })))();
      `
      const launch = reviewedGithubMcpLaunch(binary, root, proxy.port)
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(launch.command, [...launch.args, process.execPath, '-e', script], {
          cwd: root,
          env: {},
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = ''
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
        child.on('error', reject)
        child.on('close', (code) =>
          code === 0 ? resolve(stdout) : reject(new Error(`Sandbox probe exited ${code}`)),
        )
      })
      expect(JSON.parse(output)).toEqual({
        metadata: false,
        binary: true,
        private: false,
        home: false,
        directory: false,
        write: false,
        proxy: true,
        other: false,
      })
    } finally {
      proxy.server.close()
      denied.server.close()
      rmSync(root, { recursive: true, force: true })
      rmSync(homeRoot, { recursive: true, force: true })
    }
  },
)
