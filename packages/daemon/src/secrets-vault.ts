import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import type { SecretResolver } from './model-routing.ts'
import { openGcm, sealGcm } from './secret-crypto.ts'

/**
 * Secrets vault (issue #15 D2, docs/SECURITY.md §4): API keys and OAuth
 * tokens live encrypted at rest under `<rootDir>/secrets.vault`; the agent
 * only ever sees opaque `secret://vault/<name>` references, resolved here
 * at call time by transport-layer constructors — never handed to the
 * agent's context.
 */
export const VAULT_FILE_NAME = 'secrets.vault'

const VaultFileSchema = z.object({
  v: z.literal(1),
  salt: z.string().min(1),
  iv: z.string().min(1),
  tag: z.string().min(1),
  ct: z.string().min(1),
})

type VaultFile = z.infer<typeof VaultFileSchema>

interface VaultPayload {
  version: 1
  entries: Record<string, string>
}

const SECRET_REF_PATTERN = /^secret:\/\/vault\/(.+)$/

/** Domain-separation label for the vault's scrypt key (see `secret-crypto.ts`). */
const VAULT_LABEL = 'vault:'

/**
 * Reads vault key material: a keyfile named by `VEDUTA_VAULT_KEYFILE` wins
 * over the inline `VEDUTA_VAULT_KEY`; neither is required (a fresh install
 * with no vault file has nothing to decrypt).
 */
export function resolveVaultKeyMaterial(env: NodeJS.ProcessEnv = process.env): Buffer | undefined {
  const keyfilePath = env['VEDUTA_VAULT_KEYFILE']
  if (keyfilePath) return Buffer.from(readFileSync(keyfilePath, 'utf8').trim(), 'utf8')
  const inline = env['VEDUTA_VAULT_KEY']
  return inline !== undefined ? Buffer.from(inline, 'utf8') : undefined
}

function readVaultFile(path: string, keyMaterial: Buffer): Map<string, string> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`secrets vault at ${path} is not valid JSON: ${errorText(error)}`)
  }
  const file = VaultFileSchema.parse(raw)
  let plaintext: Buffer
  try {
    plaintext = openGcm({ label: VAULT_LABEL, keyMaterial, ...file })
  } catch {
    // Wrong key material or a tampered header/ciphertext (the AAD covers
    // salt/iv, GCM covers the ciphertext) both surface as an auth failure
    // here — never partial or silently-wrong data.
    throw new Error(
      `failed to decrypt secrets vault at ${path}: wrong key material or corrupted file`,
    )
  }
  const payload = JSON.parse(plaintext.toString('utf8')) as VaultPayload
  return new Map(Object.entries(payload.entries))
}

function writeVaultFile(path: string, keyMaterial: Buffer, entries: Map<string, string>): void {
  const payload: VaultPayload = { version: 1, entries: Object.fromEntries(entries) }
  const sealed = sealGcm({
    label: VAULT_LABEL,
    keyMaterial,
    plaintext: Buffer.from(JSON.stringify(payload), 'utf8'),
  })
  const file: VaultFile = { v: 1, ...sealed }
  writeFileAtomic(path, JSON.stringify(file))
}

/**
 * Write-tmp-then-rename. The tmp file is opened with `wx` (`O_CREAT |
 * O_EXCL`), which doubles as a naive concurrent-writer lock: a leftover tmp
 * file from another writer (or a crashed one) is a clear, actionable error
 * rather than a silent clobber. `fsync` covers both the file and its parent
 * directory so the rename is durable across a crash, not just visible.
 */
function writeFileAtomic(path: string, content: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${path}.tmp`
  let fd: number
  try {
    fd = openSync(tmpPath, 'wx', 0o600)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'EEXIST') {
      throw new Error(
        `${tmpPath} already exists — the vault is being written by another process, or a previous write crashed; remove the stale file and retry`,
      )
    }
    throw error
  }
  try {
    writeSync(fd, content, 0, 'utf8')
    fsyncSync(fd)
  } catch (error) {
    closeSync(fd)
    unlinkSync(tmpPath)
    throw error
  }
  closeSync(fd)
  renameSync(tmpPath, path)
  const dirFd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SecretsVault implements SecretResolver {
  private readonly path: string
  private readonly keyMaterial: Buffer
  private readonly entries: Map<string, string>

  private constructor(path: string, keyMaterial: Buffer, entries: Map<string, string>) {
    this.path = path
    this.keyMaterial = keyMaterial
    this.entries = entries
  }

  /**
   * Loads and decrypts the vault file under `rootDir`, or starts empty when
   * none exists yet (a fresh install has nothing to decrypt). An existing
   * file that fails to decrypt or authenticate throws — fail closed, never
   * silently reset.
   */
  static open(rootDir: string, keyMaterial: Buffer): SecretsVault {
    const path = join(rootDir, VAULT_FILE_NAME)
    if (!existsSync(path)) return new SecretsVault(path, keyMaterial, new Map())
    return new SecretsVault(path, keyMaterial, readVaultFile(path, keyMaterial))
  }

  /** Non-`secret://vault/...` refs are not ours to resolve. */
  resolve(secretRef: string): string | undefined {
    const match = SECRET_REF_PATTERN.exec(secretRef)
    if (!match?.[1]) return undefined
    return this.entries.get(match[1])
  }

  has(name: string): boolean {
    return this.entries.has(name)
  }

  set(name: string, value: string): void {
    this.entries.set(name, value)
    this.persist()
  }

  delete(name: string): boolean {
    const existed = this.entries.delete(name)
    if (existed) this.persist()
    return existed
  }

  /** Names only, sorted — values never leave the vault except via `resolve`. */
  list(): string[] {
    return [...this.entries.keys()].sort()
  }

  private persist(): void {
    writeVaultFile(this.path, this.keyMaterial, this.entries)
  }
}

/** First non-undefined resolution wins; later resolvers are only consulted when earlier ones return undefined. */
export function compositeSecretResolver(...resolvers: SecretResolver[]): SecretResolver {
  return {
    resolve(secretRef: string): string | undefined {
      for (const resolver of resolvers) {
        const value = resolver.resolve(secretRef)
        if (value !== undefined) return value
      }
      return undefined
    },
  }
}
