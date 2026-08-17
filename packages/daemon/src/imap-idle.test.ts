import { EventEmitter, once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  ImapFlow,
  type FetchMessageObject,
  type ImapFlowOptions,
  type MailboxObject,
  type StatusObject,
} from 'imapflow'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ImapIdleSource, type ImapClient, type ImapSettings } from './imap-idle.ts'
import type { ExternalEventBatch } from './external-event.ts'
import type { SecretResolver } from './model-routing.ts'

class FakeImapClient extends EventEmitter implements ImapClient {
  readonly capabilities = new Map<string, boolean | number>([['IDLE', true]])
  readonly connect = vi.fn(async () => {
    if (this.connectError) throw this.connectError
  })
  readonly close = vi.fn(() => {})
  readonly mailboxOpen = vi.fn(async () => this.mailbox)
  readonly status = vi.fn(async () =>
    fromPartial<StatusObject>({
      path: 'INBOX',
      uidValidity: this.mailbox.uidValidity,
      uidNext: this.mailbox.uidNext,
    }),
  )
  readonly messages: FetchMessageObject[] = []
  readonly fetchAll = vi.fn(
    async (
      _range: string,
      _query: { headers?: string[] },
      _options?: { uid?: boolean },
    ): Promise<FetchMessageObject[]> => [...this.messages],
  )

  constructor(
    readonly mailbox: MailboxObject,
    private readonly connectError?: Error,
  ) {
    super()
  }

  receive(message: FetchMessageObject): void {
    const prevCount = this.mailbox.exists
    this.messages.push(message)
    this.mailbox.exists += 1
    this.mailbox.uidNext = message.uid + 1
    this.emit('exists', { path: 'INBOX', count: this.mailbox.exists, prevCount })
  }
}

class ScriptedImapProtocolServer {
  readonly commands: string[] = []
  authenticatedAs: string | undefined
  private readonly server: Server
  private socket: Socket | undefined
  private input = ''
  private authenticationTag: string | undefined
  private idleTag: string | undefined
  private uidNext = 1
  private headers = Buffer.alloc(0)

  constructor() {
    this.server = createServer((socket) => {
      this.socket = socket
      socket.setEncoding('utf8')
      socket.setNoDelay(true)
      socket.on('data', (chunk: string) => this.receive(chunk))
      socket.write('* OK [CAPABILITY IMAP4rev1 IDLE AUTH=PLAIN SASL-IR] ready\r\n')
    })
  }

  async listen(): Promise<number> {
    this.server.listen(0, '127.0.0.1')
    await once(this.server, 'listening')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw new Error('fake IMAP server has no port')
    return address.port
  }

  announceMessage(headers: string): void {
    this.headers = Buffer.from(headers)
    this.uidNext += 1
    this.socket?.write(`* ${this.uidNext - 1} EXISTS\r\n`)
  }

  async stop(): Promise<void> {
    this.socket?.destroy()
    if (!this.server.listening) return
    this.server.close()
    await once(this.server, 'close')
  }

  private receive(chunk: string): void {
    this.input += chunk
    while (this.input.includes('\r\n')) {
      const boundary = this.input.indexOf('\r\n')
      const line = this.input.slice(0, boundary)
      this.input = this.input.slice(boundary + 2)
      if (line) this.handle(line)
    }
  }

  private handle(line: string): void {
    this.commands.push(line)
    if (this.authenticationTag) {
      this.authenticatedAs = Buffer.from(line, 'base64').toString('utf8')
      this.write(`${this.authenticationTag} OK authenticated\r\n`)
      this.authenticationTag = undefined
      return
    }
    if (line === 'DONE') {
      if (this.idleTag) this.write(`${this.idleTag} OK IDLE completed\r\n`)
      this.idleTag = undefined
      return
    }

    const separator = line.indexOf(' ')
    if (separator < 1) return
    const tag = line.slice(0, separator)
    const command = line
      .slice(separator + 1)
      .split(' ', 1)[0]
      ?.toUpperCase()
    switch (command) {
      case 'CAPABILITY':
        this.write(
          `* CAPABILITY IMAP4rev1 IDLE AUTH=PLAIN SASL-IR\r\n${tag} OK CAPABILITY completed\r\n`,
        )
        return
      case 'AUTHENTICATE':
        if (line.split(' ')[3]) {
          this.authenticatedAs = Buffer.from(line.split(' ')[3] ?? '', 'base64').toString('utf8')
          this.write(`${tag} OK authenticated\r\n`)
          return
        }
        this.authenticationTag = tag
        this.write('+ \r\n')
        return
      case 'LOGIN':
        this.write(`${tag} OK authenticated\r\n`)
        return
      case 'SELECT':
        this.write(
          `* FLAGS (\\Seen)\r\n* ${this.uidNext - 1} EXISTS\r\n* OK [UIDVALIDITY 42] valid\r\n* OK [UIDNEXT ${this.uidNext}] next\r\n${tag} OK [READ-WRITE] selected\r\n`,
        )
        return
      case 'STATUS':
        this.write(
          `* STATUS INBOX (UIDVALIDITY 42 UIDNEXT ${this.uidNext})\r\n${tag} OK STATUS completed\r\n`,
        )
        return
      case 'UID':
        this.writeFetch(tag)
        return
      case 'IDLE':
        this.idleTag = tag
        this.write('+ idling\r\n')
        return
      case 'LOGOUT':
        this.write(`* BYE closing\r\n${tag} OK LOGOUT completed\r\n`)
        return
      default:
        this.write(`${tag} OK ${command ?? 'command'} completed\r\n`)
    }
  }

  private writeFetch(tag: string): void {
    const section = 'BODY[HEADER.FIELDS (FROM SUBJECT LIST-UNSUBSCRIBE PRECEDENCE)]'
    this.write(
      `* 1 FETCH (UID 1 ${section} {${this.headers.byteLength}}\r\n${this.headers.toString('utf8')})\r\n${tag} OK FETCH completed\r\n`,
    )
  }

  private write(value: string): void {
    this.socket?.write(value)
  }
}

describe('ImapIdleSource', () => {
  let rootDir: string
  let source: ImapIdleSource | undefined

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-imap-idle-'))
    source = undefined
  })

  afterEach(() => {
    source?.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('connects over TLS, selects INBOX, and baselines existing mail', async () => {
    const server = new FakeImapClient(
      fromPartial<MailboxObject>({
        path: 'INBOX',
        uidValidity: 42n,
        uidNext: 8,
        exists: 7,
      }),
    )
    const batches: ExternalEventBatch[] = []
    let cursor: string | undefined
    let clientOptions: ImapFlowOptions | undefined
    const secrets: SecretResolver = {
      resolve: vi.fn((ref) => {
        if (ref === 'secret://vault/imap-user') return 'anna@example.com'
        if (ref === 'secret://vault/imap-password') return 'correct horse battery staple'
        return undefined
      }),
    }

    source = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings: {
        host: 'imap.example.com',
        port: 993,
        authMethod: 'AUTH=PLAIN',
        usernameRef: 'secret://vault/imap-user',
        passwordRef: 'secret://vault/imap-password',
      },
      secrets,
      cursor: () => cursor,
      onBatch: async (batch) => {
        batches.push(batch)
        cursor = batch.nextCursor
      },
      clientFactory: (options) => {
        clientOptions = options
        return server
      },
    })

    await source.start()

    expect(clientOptions).toMatchObject({
      host: 'imap.example.com',
      port: 993,
      secure: true,
      logger: false,
      logRaw: false,
      maxIdleTime: 25 * 60 * 1000,
      auth: {
        user: 'anna@example.com',
        pass: 'correct horse battery staple',
        loginMethod: 'AUTH=PLAIN',
      },
    })
    expect(server.mailboxOpen).toHaveBeenCalledWith('INBOX')
    expect(batches).toEqual([{ events: [], nextCursor: 'imap:v1:42:7' }])
    expect(server.fetchAll).not.toHaveBeenCalled()
  })

  it('drives AUTHENTICATE, SELECT, IDLE keepalive, and header fetch against a scripted server', async () => {
    const server = new ScriptedImapProtocolServer()
    const port = await server.listen()
    const batches: ExternalEventBatch[] = []
    let cursor: string | undefined
    let realClient: ImapFlow | undefined

    try {
      source = new ImapIdleSource({
        rootDir,
        source: 'personal-mail',
        settings: {
          host: '127.0.0.1',
          port,
          authMethod: 'AUTH=PLAIN',
          usernameRef: 'secret://vault/imap-user',
          passwordRef: 'secret://vault/imap-password',
        },
        secrets: {
          resolve: (ref) => (ref.endsWith('imap-user') ? 'anna@example.com' : 'mailbox-password'),
        },
        cursor: () => cursor,
        onBatch: async (batch) => {
          batches.push(batch)
          cursor = batch.nextCursor
        },
        clientFactory: (options) => {
          realClient = new ImapFlow({
            ...options,
            secure: false,
            doSTARTTLS: false,
            maxIdleTime: 50,
          })
          return realClient
        },
      })

      await source.start()
      void realClient?.idle()
      await vi.waitFor(
        () =>
          expect(
            server.commands.filter((command) => / IDLE$/.test(command)).length,
          ).toBeGreaterThan(1),
        { timeout: 2_000 },
      )

      server.announceMessage(
        'From: Anna Example <Anna@Example.com>\r\nSubject: Protocol proof\r\nPrecedence: normal\r\n\r\n',
      )
      await vi.waitFor(() => expect(batches.some((batch) => batch.events.length === 1)).toBe(true))

      expect(server.commands.some((command) => / AUTHENTICATE PLAIN(?: |$)/.test(command))).toBe(
        true,
      )
      expect(server.authenticatedAs).toBe('\0anna@example.com\0mailbox-password')
      expect(server.commands.some((command) => / SELECT INBOX$/.test(command))).toBe(true)
      expect(
        server.commands.some((command) =>
          /UID FETCH 1:1 .*HEADER\.FIELDS \(FROM SUBJECT LIST-UNSUBSCRIBE PRECEDENCE\)/i.test(
            command,
          ),
        ),
      ).toBe(true)
      expect(batches.at(-1)?.events[0]).toMatchObject({
        source: 'personal-mail',
        externalId: '42:1',
        sender: 'anna@example.com',
        subject: 'Protocol proof',
      })
    } finally {
      source?.stop()
      source = undefined
      await server.stop()
    }
  })

  it('fetches only selected headers when IDLE reports new mail', async () => {
    const server = new FakeImapClient(
      fromPartial<MailboxObject>({
        path: 'INBOX',
        uidValidity: 42n,
        uidNext: 8,
        exists: 7,
      }),
    )
    const batches: ExternalEventBatch[] = []
    let cursor: string | undefined
    source = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings: {
        host: 'imap.example.com',
        port: 993,
        authMethod: 'AUTH=PLAIN',
        usernameRef: 'secret://vault/imap-user',
        passwordRef: 'secret://vault/imap-password',
      },
      secrets: {
        resolve: (ref) => (ref.endsWith('imap-user') ? 'anna@example.com' : 'mailbox-password'),
      },
      cursor: () => cursor,
      onBatch: async (batch) => {
        batches.push(batch)
        cursor = batch.nextCursor
      },
      clientFactory: () => server,
    })
    await source.start()
    batches.length = 0

    server.receive(
      fromPartial<FetchMessageObject>({
        seq: 8,
        uid: 8,
        headers: Buffer.from(
          'From: Anna Example <Anna@Example.com>\r\nSubject: Dinner tonight\r\nList-Unsubscribe: <mailto:leave@example.com>\r\nPrecedence: bulk\r\n\r\n',
        ),
      }),
    )

    await vi.waitFor(() => expect(batches).toHaveLength(1))
    expect(server.fetchAll).toHaveBeenCalledWith(
      '8:8',
      { headers: ['from', 'subject', 'list-unsubscribe', 'precedence'] },
      { uid: true },
    )
    expect(batches[0]).toEqual({
      nextCursor: 'imap:v1:42:8',
      events: [
        {
          source: 'personal-mail',
          kind: 'email',
          externalId: '42:8',
          type: 'message.received',
          sender: 'anna@example.com',
          subject: 'Dinner tonight',
          headers: {
            from: 'Anna Example <Anna@Example.com>',
            subject: 'Dinner tonight',
            'list-unsubscribe': '<mailto:leave@example.com>',
            precedence: 'bulk',
          },
        },
      ],
    })
  })

  it('persists only a generic failure while reconnecting and alerts once', async () => {
    vi.useFakeTimers()
    const mailbox = () =>
      fromPartial<MailboxObject>({
        path: 'INBOX',
        uidValidity: 42n,
        uidNext: 1,
        exists: 0,
      })
    const username = 'ab'
    const password = 'xy'
    const clients = [
      new FakeImapClient(mailbox(), new Error(`server rejected ${username} ${password}`)),
      new FakeImapClient(mailbox(), new Error(`server rejected ${username} ${password}`)),
      new FakeImapClient(mailbox(), new Error(`server rejected ${username} ${password}`)),
      new FakeImapClient(mailbox()),
    ]
    const alerts: string[] = []
    const consoleError = vi.spyOn(console, 'error')
    let cursor: string | undefined
    const resolve = vi.fn((ref: string) => (ref.endsWith('imap-user') ? username : password))
    source = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings: {
        host: 'imap.example.com',
        port: 993,
        authMethod: 'LOGIN',
        usernameRef: 'secret://vault/imap-user',
        passwordRef: 'secret://vault/imap-password',
      },
      secrets: { resolve },
      cursor: () => cursor,
      onBatch: async (batch) => {
        cursor = batch.nextCursor
      },
      onAlert: (_source, message) => alerts.push(message),
      clientFactory: () => {
        const client = clients.shift()
        if (!client) throw new Error('unexpected connection attempt')
        return client
      },
    })

    await source.start()
    expect(source.health().consecutiveFailures).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(source.health().consecutiveFailures).toBe(2)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(source.health()).toMatchObject({ consecutiveFailures: 3, alerted: true })
    expect(source.health().lastError).toBe('IMAP connection failed')
    expect(source.health().lastError).not.toContain(password)
    expect(source.health().lastError).not.toContain(username)
    expect(alerts).toEqual([
      'IMAP connection for event source "personal-mail" has failed 3 times in a row; new mail may be missed until it recovers.',
    ])

    await vi.advanceTimersByTimeAsync(4_000)
    expect(source.health()).toMatchObject({ consecutiveFailures: 0, alerted: false })
    expect(source.health().lastError).toBeUndefined()
    expect(resolve).toHaveBeenCalledTimes(8)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(username)
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(password)
  })

  it('catches up from the durable UID cursor after a dropped connection', async () => {
    vi.useFakeTimers()
    const first = new FakeImapClient(
      fromPartial<MailboxObject>({
        path: 'INBOX',
        uidValidity: 42n,
        uidNext: 5,
        exists: 4,
      }),
    )
    const second = new FakeImapClient(
      fromPartial<MailboxObject>({
        path: 'INBOX',
        uidValidity: 42n,
        uidNext: 7,
        exists: 6,
      }),
    )
    second.messages.push(
      fromPartial<FetchMessageObject>({
        seq: 5,
        uid: 5,
        envelope: { subject: 'First missed message' },
      }),
      fromPartial<FetchMessageObject>({
        seq: 6,
        uid: 6,
        envelope: { subject: 'Second missed message' },
      }),
    )
    const clients = [first, second]
    const batches: ExternalEventBatch[] = []
    let cursor: string | undefined
    source = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings: {
        host: 'imap.example.com',
        port: 993,
        authMethod: 'AUTH=PLAIN',
        usernameRef: 'secret://vault/imap-user',
        passwordRef: 'secret://vault/imap-password',
      },
      secrets: { resolve: () => 'resolved-secret' },
      cursor: () => cursor,
      onBatch: async (batch) => {
        batches.push(batch)
        cursor = batch.nextCursor
      },
      clientFactory: () => {
        const client = clients.shift()
        if (!client) throw new Error('unexpected connection attempt')
        return client
      },
    })
    await source.start()
    batches.length = 0

    first.emit('close')
    expect(source.health().consecutiveFailures).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(second.fetchAll).toHaveBeenCalledWith(
      '5:6',
      { headers: ['from', 'subject', 'list-unsubscribe', 'precedence'] },
      { uid: true },
    )
    expect(batches).toHaveLength(1)
    expect(batches[0]?.events.map((event) => event.externalId)).toEqual(['42:5', '42:6'])
    expect(batches[0]?.nextCursor).toBe('imap:v1:42:6')
    expect(source.health()).toMatchObject({ consecutiveFailures: 0, alerted: false })
  })

  it('bounds mailbox catch-up and preserves the cursor while the pipeline is rate-limited', async () => {
    vi.useFakeTimers()
    const server = new FakeImapClient(
      fromPartial<MailboxObject>({
        path: 'INBOX',
        uidValidity: 42n,
        uidNext: 3,
        exists: 2,
      }),
    )
    server.messages.push(
      fromPartial<FetchMessageObject>({
        seq: 1,
        uid: 1,
        headers: Buffer.from('From: one@example.com\r\nSubject: One\r\n\r\n'),
      }),
      fromPartial<FetchMessageObject>({
        seq: 2,
        uid: 2,
        headers: Buffer.from('From: two@example.com\r\nSubject: Two\r\n\r\n'),
      }),
    )
    let cursor = 'imap:v1:42:0'
    let deliveryAttempts = 0
    source = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings: {
        host: 'imap.example.com',
        port: 993,
        authMethod: 'AUTH=PLAIN',
        usernameRef: 'secret://vault/imap-user',
        passwordRef: 'secret://vault/imap-password',
      },
      secrets: { resolve: () => 'resolved-secret' },
      cursor: () => cursor,
      maxBatchSize: 1,
      onBatch: async (batch) => {
        deliveryAttempts += 1
        if (deliveryAttempts === 1) return { rateLimited: true as const }
        cursor = batch.nextCursor
        return {}
      },
      clientFactory: () => server,
    })

    await source.start()
    expect(server.fetchAll).toHaveBeenCalledTimes(1)
    expect(server.fetchAll).toHaveBeenLastCalledWith(
      '1:1',
      { headers: ['from', 'subject', 'list-unsubscribe', 'precedence'] },
      { uid: true },
    )
    expect(cursor).toBe('imap:v1:42:0')
    expect(source.health()).toMatchObject({ consecutiveFailures: 0, alerted: false })

    await vi.advanceTimersByTimeAsync(59_999)
    expect(server.fetchAll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await vi.runOnlyPendingTimersAsync()

    expect(cursor).toBe('imap:v1:42:2')
    expect(server.fetchAll.mock.calls.map(([range]) => range)).toEqual(['1:1', '1:1', '2:2'])
  })

  it('retains consecutive connection health across a restart', async () => {
    const settings: ImapSettings = {
      host: 'imap.example.com',
      port: 993,
      authMethod: 'AUTH=PLAIN',
      usernameRef: 'secret://vault/imap-user',
      passwordRef: 'secret://vault/imap-password',
    }
    const failingClient = () =>
      new FakeImapClient(
        fromPartial<MailboxObject>({
          path: 'INBOX',
          uidValidity: 42n,
          uidNext: 1,
          exists: 0,
        }),
        new Error('offline'),
      )
    const first = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings,
      secrets: { resolve: () => 'resolved-secret' },
      cursor: () => undefined,
      onBatch: async () => {},
      clientFactory: failingClient,
    })
    source = first
    await first.start()
    expect(first.health().consecutiveFailures).toBe(1)
    first.stop()

    const reopened = new ImapIdleSource({
      rootDir,
      source: 'personal-mail',
      settings,
      secrets: { resolve: () => 'resolved-secret' },
      cursor: () => undefined,
      onBatch: async () => {},
      clientFactory: failingClient,
    })
    source = reopened
    await reopened.start()

    expect(reopened.health().consecutiveFailures).toBe(2)
  })
})
