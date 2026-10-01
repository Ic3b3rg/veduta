import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GatewayServerMessageSchema,
  HimalayaConnectionsSnapshotSchema,
  SurfaceSchema,
  type GatewayServerMessage,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandRequest, CommandResult } from './general-execution.ts'
import { HimalayaConnections } from './himalaya-connections.ts'
import { SecretsVault } from './secrets-vault.ts'
import { buildServer } from './server.ts'

class Socket {
  sent: GatewayServerMessage[] = []
  private receiveFrame: ((raw: Buffer | string) => void) | undefined
  send(raw: string) {
    this.sent.push(GatewayServerMessageSchema.parse(JSON.parse(raw)))
  }
  on(event: 'message' | 'close', handler: (raw: Buffer | string) => void) {
    if (event === 'message') this.receiveFrame = handler
  }
  receive(frame: unknown) {
    this.receiveFrame?.(JSON.stringify(frame))
  }
}

const dirs: string[] = []
afterEach(() => {
  delete process.env['VEDUTA_VAULT_KEY']
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'veduta-himalaya-flow-'))
  dirs.push(dir)
  process.env['VEDUTA_VAULT_KEY'] = 'himalaya-flow-vault-key'
  return dir
}

function contents(dir: string): string {
  return readdirSync(dir)
    .map((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? contents(path) : readFileSync(path, 'utf8')
    })
    .join('\n')
}

function outcome(request: CommandRequest, stdout: string, exitCode = 0): CommandResult {
  return {
    command: request.command,
    cwd: request.cwd,
    durationMs: 1,
    exitCode,
    cancelled: false,
    timedOut: false,
    outputLimited: false,
    stdout,
    stderr: '',
  }
}

describe('Himalaya Mailbox through focused Chat', () => {
  it('uses the reviewed general execution path for explicit Chat setup without an Approval card', async () => {
    const dataDir = root()
    const commands: string[] = []
    const commandRun = vi.fn(async (request: CommandRequest) => {
      commands.push(request.command)
      if (request.command === 'himalaya --version') {
        return outcome(request, '', 127)
      }
      throw new Error(`Unexpected setup command ${request.command}`)
    })
    const himalayaRun = vi.fn(async (request: CommandRequest) =>
      outcome(request, 'himalaya v2.1.0 +reviewed\n'),
    )
    const server = buildServer({ dataDir, commandRun, himalayaRun })
    try {
      const socket = new Socket()
      server.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      socket.receive({ type: 'chat.send', text: 'Set up Himalaya', spaceId: 'spc-health' })
      await vi.waitFor(() =>
        expect(socket.sent.some((frame) => frame.type === 'chat.turn-end')).toBe(true),
      )
      expect(commands).toEqual(['himalaya --version'])
      expect(himalayaRun).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'himalaya --version' }),
      )
      expect(socket.sent.some((frame) => frame.type === 'approval.card')).toBe(false)
      expect(socket.sent.find((frame) => frame.type === 'chat.turn-end')).toMatchObject({
        message: { text: expect.stringContaining('Himalaya 2.1.0 is installed') },
      })
      expect(
        server.store.eventLog('spc-health').filter((event) => event.type === 'tool.execution'),
      ).toHaveLength(2)
    } finally {
      await server.app.close()
    }
  })

  it('verifies two accounts without mail access and produces the same safe Surface shape', async () => {
    const dataDir = root()
    const commands: string[] = []
    const flags = [{ raw: '\\Flagged', iana: 'flagged' }]
    const run = vi.fn(async (request: CommandRequest) => {
      commands.push(request.command)
      if (request.command === 'himalaya --version')
        return outcome(request, 'himalaya v2.1.0 +reviewed\n')
      if (request.command.includes('account') && request.command.includes('check')) {
        const account = /-a '([^']+)'/.exec(request.command)?.[1]
        return outcome(
          request,
          JSON.stringify({
            account,
            backends: [
              { backend: 'imap', ok: true, error: null },
              { backend: 'smtp', ok: true, error: null },
            ],
          }),
        )
      }
      if (request.command.includes('envelope') && request.command.includes('search')) {
        return outcome(
          request,
          JSON.stringify({
            envelopes: [
              {
                id: '42',
                subject: 'Weekly newsletter',
                from: [{ name: 'Editor', email: 'editor@example.test' }],
                date: '2026-10-01T08:00:00Z',
                flags,
              },
            ],
          }),
        )
      }
      if (request.command.includes('message') && request.command.includes('read')) {
        return outcome(request, 'PRIVATE-IMAP-MESSAGE-DO-NOT-PERSIST')
      }
      throw new Error(`Unexpected fixture command: ${request.command}`)
    })
    const server = buildServer({
      dataDir,
      himalayaRun: run,
      now: () => new Date('2026-10-01T12:00:00Z'),
    })
    try {
      const ids: string[] = []
      for (const [name, address] of [
        ['Work', 'work@example.test'],
        ['Family', 'family@example.test'],
      ]) {
        const created = await server.app.inject({
          method: 'POST',
          url: '/api/himalaya-connections',
          payload: {
            name,
            address,
            imapServer: 'imaps://imap.example.test:993',
            imapUsername: address,
            imapPassword: `imap-secret-${name}`,
            smtpServer: 'smtps://smtp.example.test:465',
            smtpUsername: address,
            smtpPassword: `smtp-secret-${name}`,
          },
        })
        expect(created.statusCode).toBe(200)
        const id = HimalayaConnectionsSnapshotSchema.parse(created.json()).connections.at(-1)!.id
        ids.push(id)
        const verified = await server.app.inject({
          method: 'POST',
          url: `/api/himalaya-connections/${id}/verify`,
          payload: {},
        })
        expect(
          HimalayaConnectionsSnapshotSchema.parse(verified.json()).connections.find(
            (account) => account.id === id,
          )?.state,
        ).toBe('ready')
      }
      expect(
        commands.some((command) => command.includes('envelope') || command.includes('message')),
      ).toBe(false)
      const configs = readdirSync(join(dataDir, 'himalaya-config')).map((file) =>
        readFileSync(join(dataDir, 'himalaya-config', file), 'utf8'),
      )
      expect(configs).toHaveLength(2)
      expect(configs.join('\n')).not.toContain('imap-secret')
      for (const id of ids) {
        expect(configs.filter((content) => content.includes(id))).toHaveLength(1)
      }

      const socket = new Socket()
      server.gateway.connect(socket)
      socket.receive({ type: 'hello', surfaceCursor: server.store.latestSurfaceCursor() })
      socket.receive({
        type: 'chat.send',
        text: 'Summarize the last five newsletters in Work',
        spaceId: 'spc-health',
      })
      await vi.waitFor(() =>
        expect(socket.sent.some((frame) => frame.type === 'chat.turn-end')).toBe(true),
      )
      expect(socket.sent.some((frame) => frame.type === 'chat.turn-error')).toBe(false)
      expect(flags).toEqual([{ raw: '\\Flagged', iana: 'flagged' }])
      expect(
        commands.some((command) => command.includes('envelope') && command.includes("'-s' '5'")),
      ).toBe(true)
      expect(
        commands.some(
          (command) =>
            command.includes('message') && command.includes('read') && !command.includes('--seen'),
        ),
      ).toBe(true)
      expect(
        commands.some(
          (command) =>
            command.includes('-a') && command.includes(ids[1]!) && command.includes('envelope'),
        ),
      ).toBe(false)
      const mailbox = server.store
        .listAuthorableSurfaces('spc-health')
        .surfaces.find((surface) => surface.title === 'Mailbox')!
      const surface = SurfaceSchema.parse(server.store.getSurface(mailbox.id))
      expect(JSON.stringify(surface)).toContain('Last checked')
      expect(JSON.stringify(surface)).not.toContain('PRIVATE-IMAP-MESSAGE')
      expect(server.store.eventLog('spc-health').at(-1)?.payload?.['toolCalls']).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ toolName: 'load_skill' }),
          expect.objectContaining({ toolName: 'search_mailbox' }),
        ]),
      )
      expect(contents(dataDir)).not.toContain('PRIVATE-IMAP-MESSAGE-DO-NOT-PERSIST')
      expect(contents(dataDir)).not.toContain('imap-secret-Work')
      expect(contents(dataDir)).not.toContain('smtp-secret-Work')
    } finally {
      await server.app.close()
    }
  })

  it('adopts archived IMAP IDLE credentials idempotently without contacting the provider', () => {
    const dataDir = root()
    const vault = SecretsVault.open(dataDir, Buffer.from('himalaya-flow-vault-key'))
    vault.set('archived-username', 'old@example.test')
    vault.set('archived-password', 'archived-imap-secret')
    writeFileSync(
      join(dataDir, 'ingestion.json'),
      JSON.stringify({
        sources: {
          oldmail: {
            adapter: 'imap-idle',
            spaceId: 'spc-health',
            ratePerMinute: 60,
            filters: {},
            imap: {
              host: 'imap.old.test',
              port: 993,
              authMethod: 'AUTH=PLAIN',
              usernameRef: 'secret://vault/archived-username',
              passwordRef: 'secret://vault/archived-password',
            },
          },
        },
      }),
    )
    const run = vi.fn(async (request: CommandRequest) => outcome(request, ''))
    const options = { rootDir: dataDir, vault, secrets: vault, run }
    const first = new HimalayaConnections(options)
    const second = new HimalayaConnections(options)
    expect(first.snapshot().connections).toEqual(second.snapshot().connections)
    expect(second.snapshot().connections).toMatchObject([
      {
        id: 'svc-himalaya-legacy-oldmail',
        state: 'needs_smtp',
        imapServer: 'imaps://imap.old.test:993',
      },
    ])
    expect(run).not.toHaveBeenCalled()
    second.completeLegacy('svc-himalaya-legacy-oldmail', {
      name: 'Old Mail',
      address: 'old@example.test',
      smtpServer: 'smtps://smtp.old.test:465',
      smtpUsername: 'old@example.test',
      smtpPassword: 'new-smtp-secret',
    })
    expect(vault.resolve('secret://vault/archived-password')).toBe('archived-imap-secret')
    expect(second.snapshot().connections[0]?.state).toBe('needs_verification')
    first.close()
    second.close()
  })

  it('verifies an account when another account has lost its credential', async () => {
    const dataDir = root()
    const vault = SecretsVault.open(dataDir, Buffer.from('himalaya-flow-vault-key'))
    let unavailable = ''
    const run = vi.fn(async (request: CommandRequest) => {
      if (request.command === 'himalaya --version') return outcome(request, 'himalaya v2.1.0\n')
      const account = /-a '([^']+)'/.exec(request.command)?.[1]
      return outcome(
        request,
        JSON.stringify({
          account,
          backends: [
            { backend: 'imap', ok: true },
            { backend: 'smtp', ok: true },
          ],
        }),
      )
    })
    const connections = new HimalayaConnections({
      rootDir: dataDir,
      vault,
      secrets: { resolve: (ref) => (ref === unavailable ? undefined : vault.resolve(ref)) },
      run,
    })
    try {
      const input = (name: string) => ({
        name,
        address: `${name.toLowerCase()}@example.test`,
        imapServer: 'imaps://imap.example.test:993',
        imapUsername: `${name.toLowerCase()}@example.test`,
        imapPassword: `imap-${name}`,
        smtpServer: 'smtps://smtp.example.test:465',
        smtpUsername: `${name.toLowerCase()}@example.test`,
        smtpPassword: `smtp-${name}`,
      })
      const first = connections.create(input('First')).connections[0]!.id
      const second = connections.create(input('Second')).connections[1]!.id
      unavailable = `secret://vault/himalaya-imap-${first}`
      const verified = await connections.verify(second)
      expect(verified.connections.find((connection) => connection.id === second)?.state).toBe(
        'ready',
      )
      const config = readdirSync(join(dataDir, 'himalaya-config'))
        .map((file) => readFileSync(join(dataDir, 'himalaya-config', file), 'utf8'))
        .join('\n')
      expect(config).toContain(second)
      expect(config).not.toContain(first)
    } finally {
      connections.close()
    }
  })
})
