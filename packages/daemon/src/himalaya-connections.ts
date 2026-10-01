import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HimalayaConnectionSchema,
  HimalayaConnectionsSnapshotSchema,
  type CreateHimalayaConnectionRequest,
  type HimalayaConnection,
  type HimalayaConnectionsSnapshot,
} from '@veduta/protocol'
import { z } from 'zod'
import { backupFile, writeJsonAtomic } from './config-backup.ts'
import { runCommand, type CommandRequest, type CommandResult } from './general-execution.ts'
import { loadIngestionConfig } from './ingestion-config.ts'
import { readJsonFile } from './json-file.ts'
import type { SecretResolver } from './model-routing.ts'
import { defaultRedactor } from './redaction.ts'
import type { SecretsVault } from './secrets-vault.ts'

const FILE_NAME = 'himalaya-connections.json'
const REVIEWED_VERSION = '2.1.0'
const RELEASES: globalThis.Record<string, { asset: string; sha256: string }> = {
  'darwin-arm64': {
    asset: 'himalaya.aarch64-darwin.tgz',
    sha256: 'a5a787b7c4dbf065408e7772908fc75c799626f4cebab8e9c78fafe3e2fa585c',
  },
  'darwin-x64': {
    asset: 'himalaya.x86_64-darwin.tgz',
    sha256: '0e61604709e7e84b5142ebebc85c52d7beb38f09ffd3506fae6041245c35d2a7',
  },
  'linux-arm64': {
    asset: 'himalaya.aarch64-linux.tgz',
    sha256: 'c41adab4bc220ba816cdbf865a5df8dc3b358b39ec58b4be0ed2f64e46b1d182',
  },
  'linux-x64': {
    asset: 'himalaya.x86_64-linux.tgz',
    sha256: '683a2ab8e1534f01e6bda3a69e204d564c31fbfbe20511fc7bc60b67f2e85884',
  },
}

function reviewedVersion(output: string): boolean {
  return /^himalaya v?2\.1\.0(?:\s|$)/m.test(output.trim())
}
const SecretRefSchema = z.string().regex(/^secret:\/\/(vault|env)\/[a-zA-Z0-9_-]+$/)
const RecordSchema = HimalayaConnectionSchema.extend({
  imapUsername: z.string().optional(),
  imapUsernameRef: SecretRefSchema.optional(),
  smtpUsername: z.string().optional(),
  imapPasswordRef: SecretRefSchema,
  smtpPasswordRef: SecretRefSchema.optional(),
  legacySource: z.string().optional(),
  imapAuthMethod: z.enum(['LOGIN', 'AUTH=LOGIN', 'AUTH=PLAIN']).optional(),
}).strict()
const FileSchema = z
  .object({
    version: z.literal(1),
    connections: z.array(RecordSchema),
    dismissedLegacyIds: z.array(z.string()).default([]),
  })
  .strict()
const CheckSchema = z.object({
  account: z.string(),
  backends: z.array(
    z.object({ backend: z.string(), ok: z.boolean(), error: z.string().nullable().optional() }),
  ),
})
type Record = z.infer<typeof RecordSchema>

export class HimalayaConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function publicRecord(record: Record): HimalayaConnection {
  const { id, name, address, imapServer, smtpServer, state, reason, createdAt, updatedAt } = record
  return HimalayaConnectionSchema.parse({
    id,
    name,
    ...(address === undefined ? {} : { address }),
    imapServer,
    ...(smtpServer === undefined ? {} : { smtpServer }),
    state,
    ...(reason === undefined ? {} : { reason }),
    createdAt,
    updatedAt,
  })
}

export interface HimalayaConnectionsOptions {
  rootDir: string
  vault: SecretsVault | undefined
  secrets: SecretResolver
  now?: () => Date
  run?: (request: CommandRequest) => Promise<CommandResult>
}

export class HimalayaConnections {
  private readonly recordsPath: string
  private readonly configDir: string
  private readonly managedBinaryPath: string
  private readonly now: () => Date
  private readonly run: (request: CommandRequest) => Promise<CommandResult>
  private records: Record[]
  private readonly dismissedLegacyIds: Set<string>
  private credentialDir: string | undefined

  constructor(private readonly options: HimalayaConnectionsOptions) {
    this.recordsPath = join(options.rootDir, FILE_NAME)
    this.configDir = join(options.rootDir, 'himalaya-config')
    this.managedBinaryPath = join(options.rootDir, 'bin', 'himalaya')
    this.now = options.now ?? (() => new Date())
    this.run = options.run ?? runCommand
    const file = existsSync(this.recordsPath)
      ? FileSchema.parse(readJsonFile(this.recordsPath, { description: 'Himalaya connections' }))
      : FileSchema.parse({ version: 1, connections: [] })
    this.records = file.connections
    this.dismissedLegacyIds = new Set(file.dismissedLegacyIds)
    this.adoptLegacySources()
  }

  snapshot(): HimalayaConnectionsSnapshot {
    return HimalayaConnectionsSnapshotSchema.parse({ connections: this.records.map(publicRecord) })
  }

  create(input: CreateHimalayaConnectionRequest): HimalayaConnectionsSnapshot {
    const vault = this.requireVault()
    if (
      this.records.some((record) => record.address?.toLowerCase() === input.address.toLowerCase())
    ) {
      throw new HimalayaConnectionError(409, 'That Mailbox account is already connected')
    }
    const id = `svc-himalaya-${randomUUID()}`
    const at = this.now().toISOString()
    const imapPasswordRef = `secret://vault/himalaya-imap-${id}`
    const smtpPasswordRef = `secret://vault/himalaya-smtp-${id}`
    defaultRedactor.register(input.imapPassword)
    defaultRedactor.register(input.smtpPassword)
    vault.set(imapPasswordRef.slice('secret://vault/'.length), input.imapPassword)
    vault.set(smtpPasswordRef.slice('secret://vault/'.length), input.smtpPassword)
    this.records.push({
      id,
      name: input.name,
      address: input.address,
      imapServer: input.imapServer,
      smtpServer: input.smtpServer,
      imapUsername: input.imapUsername,
      smtpUsername: input.smtpUsername,
      imapPasswordRef,
      smtpPasswordRef,
      state: 'needs_verification',
      createdAt: at,
      updatedAt: at,
    })
    this.persist()
    return this.snapshot()
  }

  completeLegacy(
    id: string,
    input: {
      name: string
      address: string
      smtpServer: string
      smtpUsername: string
      smtpPassword: string
    },
  ): HimalayaConnectionsSnapshot {
    const record = this.find(id)
    if (!record.legacySource || record.state !== 'needs_smtp') {
      throw new HimalayaConnectionError(409, 'This connection has no legacy IMAP setup to complete')
    }
    const vault = this.requireVault()
    const smtpPasswordRef = `secret://vault/himalaya-smtp-${id}`
    defaultRedactor.register(input.smtpPassword)
    vault.set(smtpPasswordRef.slice('secret://vault/'.length), input.smtpPassword)
    record.name = input.name
    record.address = input.address
    record.smtpServer = input.smtpServer
    record.smtpUsername = input.smtpUsername
    record.smtpPasswordRef = smtpPasswordRef
    record.state = 'needs_verification'
    record.updatedAt = this.now().toISOString()
    this.persist()
    return this.snapshot()
  }

  async verify(id: string, signal?: AbortSignal): Promise<HimalayaConnectionsSnapshot> {
    const record = this.find(id)
    if (!record.smtpServer || !record.smtpPasswordRef) {
      throw new HimalayaConnectionError(409, 'SMTP setup is incomplete')
    }
    const version = await this.run({
      command: `${this.binaryCommand()} --version`,
      cwd: this.options.rootDir,
      signal,
    })
    if (version.exitCode !== 0 || !reviewedVersion(version.stdout)) {
      record.state = 'needs_setup'
      record.reason = `Himalaya ${REVIEWED_VERSION} is required; install the reviewed release and retry`
      record.updatedAt = this.now().toISOString()
      this.persist()
      return this.snapshot()
    }
    this.materializeConfig(record)
    const check = await this.run({
      command: this.command(record.id, ['account', 'check'], true),
      cwd: this.options.rootDir,
      signal,
    })
    let valid = false
    if (check.exitCode === 0 && !check.timedOut && !check.cancelled && !check.outputLimited) {
      try {
        const report = CheckSchema.parse(JSON.parse(check.stdout))
        valid =
          report.account === record.id &&
          ['imap', 'smtp'].every((backend) =>
            report.backends.some((item) => item.backend === backend && item.ok),
          )
      } catch {
        valid = false
      }
    }
    record.state = valid ? 'ready' : 'failed'
    record.reason = valid
      ? undefined
      : 'IMAP or SMTP authentication failed; check endpoints and credentials'
    record.updatedAt = this.now().toISOString()
    this.persist()
    return this.snapshot()
  }

  async install(signal?: AbortSignal): Promise<{ state: 'ready' | 'failed'; reason?: string }> {
    const existing = await this.run({
      command: `${this.binaryCommand()} --version`,
      cwd: this.options.rootDir,
      signal,
    })
    if (existing.exitCode === 0 && reviewedVersion(existing.stdout)) return this.installReady()
    const release = RELEASES[`${process.platform}-${process.arch}`]
    if (!release)
      return { state: 'failed', reason: 'No reviewed Himalaya binary exists for this platform' }
    const temporary = mkdtempSync(join(this.options.rootDir, '.himalaya-install-'))
    const archive = join(temporary, release.asset)
    try {
      const url = `https://github.com/pimalaya/himalaya/releases/download/v${REVIEWED_VERSION}/${release.asset}`
      const download = await this.run({
        command: `curl --fail --location --silent --show-error --max-time 120 --max-filesize 30000000 --output ${shellQuote(archive)} ${shellQuote(url)}`,
        cwd: this.options.rootDir,
        deadlineMs: 130_000,
        signal,
      })
      if (
        download.exitCode !== 0 ||
        download.timedOut ||
        download.cancelled ||
        download.outputLimited
      ) {
        return {
          state: 'failed',
          reason: 'The reviewed Himalaya release could not be downloaded; retry setup',
        }
      }
      const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
      if (digest !== release.sha256)
        return { state: 'failed', reason: 'Himalaya release checksum did not match' }
      const extracted = await this.run({
        command: `tar -xzf ${shellQuote(archive)} -C ${shellQuote(temporary)} himalaya`,
        cwd: this.options.rootDir,
        signal,
      })
      if (
        extracted.exitCode !== 0 ||
        extracted.timedOut ||
        extracted.cancelled ||
        extracted.outputLimited
      ) {
        return { state: 'failed', reason: 'The reviewed Himalaya release could not be unpacked' }
      }
      mkdirSync(join(this.options.rootDir, 'bin'), { recursive: true, mode: 0o700 })
      const candidate = join(temporary, 'himalaya')
      chmodSync(candidate, 0o700)
      const verified = await this.run({
        command: `${shellQuote(candidate)} --version`,
        cwd: this.options.rootDir,
        signal,
      })
      if (verified.exitCode !== 0 || !reviewedVersion(verified.stdout)) {
        return { state: 'failed', reason: 'The reviewed Himalaya binary could not be verified' }
      }
      const staged = `${this.managedBinaryPath}.tmp-${randomUUID()}`
      copyFileSync(candidate, staged)
      chmodSync(staged, 0o700)
      renameSync(staged, this.managedBinaryPath)
    } catch {
      return { state: 'failed', reason: 'Himalaya installation failed; retry setup' }
    } finally {
      rmSync(temporary, { recursive: true, force: true })
    }
    return this.installReady()
  }

  private installReady(): { state: 'ready' } {
    for (const record of this.records) {
      if (record.state === 'needs_setup') {
        record.state = 'needs_verification'
        delete record.reason
      }
    }
    this.persist()
    return { state: 'ready' }
  }

  async executeForAccount(
    id: string,
    args: readonly string[],
    json: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const record = this.find(id)
    if (record.state !== 'ready')
      throw new HimalayaConnectionError(409, 'Mailbox needs verification')
    this.materializeConfig(record)
    const result = await this.run({
      command: this.command(id, args, json),
      cwd: this.options.rootDir,
      signal,
    })
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.outputLimited) {
      throw new HimalayaConnectionError(502, 'Himalaya Mailbox read failed')
    }
    return result.stdout
  }

  remove(id: string): HimalayaConnectionsSnapshot {
    const record = this.find(id)
    this.records = this.records.filter((candidate) => candidate.id !== id)
    if (record.legacySource) this.dismissedLegacyIds.add(id)
    this.persist()
    for (const ref of [record.imapPasswordRef, record.smtpPasswordRef]) {
      if (ref?.startsWith('secret://vault/himalaya-')) {
        this.options.vault?.delete(ref.slice('secret://vault/'.length))
      }
    }
    const key = this.accountKey(id)
    if (this.credentialDir) {
      rmSync(join(this.credentialDir, `${key}-imap`), { force: true })
      rmSync(join(this.credentialDir, `${key}-smtp`), { force: true })
    }
    rmSync(this.configPathFor(id), { force: true })
    return this.snapshot()
  }

  rename(id: string, name: string): HimalayaConnectionsSnapshot {
    const record = this.find(id)
    record.name = name
    record.updatedAt = this.now().toISOString()
    this.persist()
    return this.snapshot()
  }

  close(): void {
    if (this.credentialDir) rmSync(this.credentialDir, { recursive: true, force: true })
    this.credentialDir = undefined
  }

  private command(id: string, args: readonly string[], json: boolean): string {
    return [
      this.binaryCommand(),
      '-c',
      shellQuote(this.configPathFor(id)),
      '-a',
      shellQuote(id),
      ...(json ? ['--json'] : []),
      ...args.map(shellQuote),
    ].join(' ')
  }

  private binaryCommand(): string {
    return existsSync(this.managedBinaryPath) ? shellQuote(this.managedBinaryPath) : 'himalaya'
  }

  private accountKey(id: string): string {
    return createHash('sha256').update(id).digest('hex').slice(0, 32)
  }

  private configPathFor(id: string): string {
    return join(this.configDir, `${this.accountKey(id)}.toml`)
  }

  private materializeConfig(record: Record): void {
    if (!record.smtpServer || !record.smtpPasswordRef || !record.address)
      throw new HimalayaConnectionError(409, 'SMTP setup is incomplete')
    const imapPassword = this.resolve(record.imapPasswordRef)
    const smtpPassword = this.resolve(record.smtpPasswordRef)
    const imapUsername = record.imapUsername ?? this.resolve(record.imapUsernameRef)
    const smtpUsername = record.smtpUsername
    if (!smtpUsername) throw new HimalayaConnectionError(409, 'SMTP username is missing')
    if (!this.credentialDir) {
      this.credentialDir = mkdtempSync(join(tmpdir(), 'veduta-himalaya-'))
      chmodSync(this.credentialDir, 0o700)
    }
    const key = this.accountKey(record.id)
    const imapFile = join(this.credentialDir, `${key}-imap`)
    const smtpFile = join(this.credentialDir, `${key}-smtp`)
    writeFileSync(imapFile, imapPassword, { mode: 0o600 })
    writeFileSync(smtpFile, smtpPassword, { mode: 0o600 })
    const imapStarttls = record.imapServer.startsWith('imap://')
    const smtpStarttls = record.smtpServer.startsWith('smtp://')
    const content = [
      `[accounts.${JSON.stringify(record.id)}]`,
      `email = ${JSON.stringify(record.address)}`,
      `imap.server = ${JSON.stringify(record.imapServer)}`,
      ...(imapStarttls ? ['imap.starttls = true'] : []),
      `imap.sasl.${record.imapAuthMethod === 'AUTH=PLAIN' || !record.imapAuthMethod ? 'plain' : 'login'}.username = ${JSON.stringify(imapUsername)}`,
      `imap.sasl.${record.imapAuthMethod === 'AUTH=PLAIN' || !record.imapAuthMethod ? 'plain' : 'login'}.password.command = ${JSON.stringify(['cat', imapFile])}`,
      `smtp.server = ${JSON.stringify(record.smtpServer)}`,
      ...(smtpStarttls ? ['smtp.starttls = true'] : []),
      `smtp.sasl.plain.username = ${JSON.stringify(smtpUsername)}`,
      `smtp.sasl.plain.password.command = ${JSON.stringify(['cat', smtpFile])}`,
    ].join('\n')
    mkdirSync(this.configDir, { recursive: true, mode: 0o700 })
    const path = this.configPathFor(record.id)
    const temporary = `${path}.tmp-${randomUUID()}`
    writeFileSync(temporary, `${content}\n`, { mode: 0o600 })
    renameSync(temporary, path)
  }

  private resolve(ref: string | undefined): string {
    const value = ref ? this.options.secrets.resolve(ref) : undefined
    if (!value) throw new HimalayaConnectionError(409, 'Saved Mailbox credentials are unavailable')
    defaultRedactor.register(value)
    return value
  }

  private requireVault(): SecretsVault {
    if (!this.options.vault) throw new HimalayaConnectionError(409, 'Secrets vault is unavailable')
    return this.options.vault
  }

  private find(id: string): Record {
    const record = this.records.find((candidate) => candidate.id === id)
    if (!record) throw new HimalayaConnectionError(404, 'Mailbox connection not found')
    return record
  }

  private persist(): void {
    backupFile(this.recordsPath)
    writeJsonAtomic(
      this.recordsPath,
      FileSchema.parse({
        version: 1,
        connections: this.records,
        dismissedLegacyIds: [...this.dismissedLegacyIds],
      }),
    )
  }

  private adoptLegacySources(): void {
    let changed = false
    for (const [sourceName, source] of Object.entries(
      loadIngestionConfig(this.options.rootDir).sources,
    )) {
      if (source.adapter !== 'imap-idle') continue
      const id = `svc-himalaya-legacy-${sourceName}`
      if (this.records.some((record) => record.id === id) || this.dismissedLegacyIds.has(id))
        continue
      const username = this.options.secrets.resolve(source.imap.usernameRef)
      const at = this.now().toISOString()
      this.records.push({
        id,
        name: `Imported ${sourceName}`,
        ...(username && z.string().email().safeParse(username).success
          ? { address: username }
          : {}),
        imapServer: `imaps://${source.imap.host}:${source.imap.port}`,
        imapUsernameRef: source.imap.usernameRef,
        imapPasswordRef: source.imap.passwordRef,
        imapAuthMethod: source.imap.authMethod,
        legacySource: sourceName,
        state: 'needs_smtp',
        reason: 'Add SMTP settings to finish the passive Mailbox connection',
        createdAt: at,
        updatedAt: at,
      })
      changed = true
    }
    if (changed) this.persist()
  }
}
