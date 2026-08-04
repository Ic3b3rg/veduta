import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, createReadStream } from 'node:fs'
import { compose } from 'node:stream'
import { promisify } from 'node:util'
import { createGunzip } from 'node:zlib'

/**
 * A structured tar-entry reader plus a containment preflight for self-update
 * artifacts (docs/adr/0013-signed-self-update.md; issues/043-self-update.md).
 *
 * The artifact tar.gz is already sha256-verified and sits alone in a private
 * 0700 staging directory by the time anything here runs, so no other
 * principal can substitute its bytes between preflight and extraction — a
 * clean `preflightArchive` conclusion still holds when `extractVerifiedArchive`
 * shells out to the system `tar` afterwards.
 *
 * The entry listing this module produces comes from parsing raw 512-byte tar
 * headers directly — ustar name/prefix, PAX extended headers, and GNU long
 * name/link records — never from parsing `tar -tvf` text output. A crafted
 * entry name containing a literal newline is ambiguous once it has passed
 * through a line-oriented listing; reading the binary header structure keeps
 * every entry exactly one record, regardless of what bytes its name holds.
 */

const execFileAsync = promisify(execFile)

const HEADER_SIZE = 512
const ZERO_BLOCK = Buffer.alloc(HEADER_SIZE)
const MAX_SYMLINK_DEPTH = 40

export interface TarEntry {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other'
  size: number
  linkName?: string
}

// --- Low-level byte reader --------------------------------------------------

interface ByteReader {
  /** Reads exactly `n` bytes. Returns `null` only when zero bytes remain and the source is exhausted (a clean end). Throws if the source is exhausted after some, but fewer than `n`, bytes were read. */
  readExact(n: number): Promise<Buffer | null>
  /** Discards exactly `n` bytes without buffering them, for skipping entry data. Throws on a truncated source. */
  skipExact(n: number): Promise<void>
}

function createByteReader(source: AsyncIterable<Buffer> | Buffer): ByteReader {
  let buffered = Buffer.isBuffer(source) ? source : Buffer.alloc(0)
  const iterator = Buffer.isBuffer(source) ? undefined : source[Symbol.asyncIterator]()
  let exhausted = Buffer.isBuffer(source)

  async function fill(): Promise<boolean> {
    if (exhausted || iterator === undefined) {
      exhausted = true
      return false
    }
    const next = await iterator.next()
    if (next.done === true) {
      exhausted = true
      return false
    }
    buffered = buffered.length === 0 ? next.value : Buffer.concat([buffered, next.value])
    return true
  }

  return {
    async readExact(n) {
      while (buffered.length < n) {
        if (!(await fill())) {
          if (buffered.length === 0) return null
          throw new Error('truncated tar archive: unexpected end of input while reading a header')
        }
      }
      const result = Buffer.from(buffered.subarray(0, n))
      buffered = buffered.subarray(n)
      return result
    },
    async skipExact(n) {
      let remaining = n
      while (remaining > 0) {
        if (buffered.length === 0) {
          if (!(await fill())) {
            throw new Error(
              'truncated tar archive: unexpected end of input while skipping entry data',
            )
          }
        }
        const take = Math.min(remaining, buffered.length)
        buffered = buffered.subarray(take)
        remaining -= take
      }
    },
  }
}

// --- Header field parsing ----------------------------------------------------

function readCString(buf: Buffer, offset: number, length: number): string {
  const field = buf.subarray(offset, offset + length)
  const nul = field.indexOf(0)
  const trimmed = nul === -1 ? field : field.subarray(0, nul)
  return trimmed.toString('utf8')
}

function trimNulTerminated(buf: Buffer): string {
  const nul = buf.indexOf(0)
  const trimmed = nul === -1 ? buf : buf.subarray(0, nul)
  return trimmed.toString('utf8')
}

function parseOctal(field: Buffer): number {
  const text = field
    .toString('latin1')
    .replace(/[\0 ]+$/g, '')
    .trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isFinite(value)) throw new Error('malformed tar header: invalid octal size field')
  return value
}

type PaxOverrides = Partial<Record<'path' | 'linkpath' | 'size', string>>

/** Parses PAX extended header records: `<decimal length> key=value\n`, repeated. The explicit length prefix (not a newline delimiter) is what lets a `value` safely contain embedded newlines without ambiguity, as `tar-reader.test.ts`'s newline-poisoned-name cases exercise. */
function parsePaxRecords(data: Buffer): PaxOverrides {
  const result: PaxOverrides = {}
  let offset = 0
  while (offset < data.length) {
    const spaceIndex = data.indexOf(0x20, offset)
    if (spaceIndex === -1) break
    const lenText = data.subarray(offset, spaceIndex).toString('latin1')
    const len = Number.parseInt(lenText, 10)
    if (!Number.isFinite(len) || len <= 0) {
      throw new Error('malformed PAX extended header: invalid record length')
    }
    const record = data.subarray(offset, offset + len).toString('utf8')
    const eq = record.indexOf('=')
    if (eq === -1) throw new Error('malformed PAX extended header: record missing "="')
    const key = record.slice(lenText.length + 1, eq)
    const value = record.slice(eq + 1).replace(/\n$/, '')
    if (key === 'path' || key === 'linkpath' || key === 'size') result[key] = value
    offset += len
  }
  return result
}

function mapTypeflag(flag: string): TarEntry['type'] {
  switch (flag) {
    case '0':
    case '\0':
      return 'file'
    case '5':
      return 'dir'
    case '2':
      return 'symlink'
    case '1':
      return 'hardlink'
    default:
      return 'other'
  }
}

interface RawHeader {
  name: string
  typeflag: string
  linkName: string
  size: number
}

function parseHeader(buf: Buffer): RawHeader {
  const sizeField = buf.subarray(124, 136)
  if (((sizeField[0] ?? 0) & 0x80) !== 0) {
    // GNU base-256 size encoding (needed once a file exceeds ~8GB, the
    // largest value the 12-byte octal field can hold). Deliberately not
    // implemented: an archive using it is refused outright rather than
    // parsed, since guessing wrong about a header's size field would also
    // misalign every subsequent header read.
    throw new Error(
      'tar entry uses unsupported GNU base-256 size encoding (likely a file over 8GB); refusing to parse the archive',
    )
  }
  const size = parseOctal(sizeField)
  const typeflag = String.fromCharCode(buf[156] ?? 0)
  const linkName = readCString(buf, 157, 100)
  const magic = buf.subarray(257, 263).toString('latin1')
  const prefix = magic.startsWith('ustar') ? readCString(buf, 345, 155) : ''
  const nameField = readCString(buf, 0, 100)
  const name = prefix.length > 0 ? `${prefix}/${nameField}` : nameField
  return { name, typeflag, linkName, size }
}

// --- Entry stream -------------------------------------------------------------

/**
 * Parses raw tar bytes into a stream of entries. Handles ustar name+prefix
 * joining, PAX extended headers (typeflag `x`; `path`/`linkpath`/`size`
 * overrides apply to the following entry only), GNU long name/link
 * (typeflags `L`/`K`, same one-entry-ahead semantics), and the two-zero-block
 * terminator. A PAX global header (typeflag `g`) is rejected outright — this
 * system has no use for archive-wide PAX defaults and silently ignoring one
 * would be a way to smuggle attacker-controlled metadata past review.
 */
export async function* readTarEntries(
  source: AsyncIterable<Buffer> | Buffer,
): AsyncGenerator<TarEntry> {
  const reader = createByteReader(source)
  let pendingName: string | undefined
  let pendingLinkName: string | undefined
  let pendingSize: number | undefined
  let sawZeroBlock = false

  for (;;) {
    const headerBuf = await reader.readExact(HEADER_SIZE)
    if (headerBuf === null) break

    if (ZERO_BLOCK.equals(headerBuf)) {
      if (sawZeroBlock) break
      sawZeroBlock = true
      continue
    }
    sawZeroBlock = false

    const header = parseHeader(headerBuf)
    const paddedSize = Math.ceil(header.size / HEADER_SIZE) * HEADER_SIZE

    if (header.typeflag === 'g') {
      throw new Error(
        'tar archive contains a PAX global extended header ("g" typeflag), which is not supported and is rejected',
      )
    }

    if (header.typeflag === 'x') {
      const data = await reader.readExact(paddedSize)
      if (data === null) throw new Error('truncated tar archive: PAX extended header data missing')
      const overrides = parsePaxRecords(data.subarray(0, header.size))
      if (overrides.path !== undefined) pendingName = overrides.path
      if (overrides.linkpath !== undefined) pendingLinkName = overrides.linkpath
      if (overrides.size !== undefined) {
        const parsedSize = Number.parseInt(overrides.size, 10)
        if (!Number.isFinite(parsedSize))
          throw new Error('malformed PAX extended header: invalid size record')
        pendingSize = parsedSize
      }
      continue
    }

    if (header.typeflag === 'L' || header.typeflag === 'K') {
      const data = await reader.readExact(paddedSize)
      if (data === null) throw new Error('truncated tar archive: GNU long name/link data missing')
      const value = trimNulTerminated(data.subarray(0, header.size))
      if (header.typeflag === 'L') pendingName = value
      else pendingLinkName = value
      continue
    }

    const name = pendingName ?? header.name
    const linkName = pendingLinkName ?? header.linkName
    const size = pendingSize ?? header.size
    pendingName = undefined
    pendingLinkName = undefined
    pendingSize = undefined

    const type = mapTypeflag(header.typeflag)
    const entry: TarEntry =
      linkName.length > 0 ? { name, type, size, linkName } : { name, type, size }
    yield entry

    await reader.skipExact(paddedSize)
  }
}

/** Pipes `filePath` through gzip decompression into `readTarEntries`. `stream.compose` (not `.pipe`) is used so a read or decompression error propagates to the consuming `for await`, instead of being swallowed as an unhandled stream `error` event. */
export async function* readTarGzEntries(filePath: string): AsyncGenerator<TarEntry> {
  const composed = compose(createReadStream(filePath), createGunzip())
  yield* readTarEntries(composed as unknown as AsyncIterable<Buffer>)
}

// --- Containment preflight ----------------------------------------------------

export interface PreflightPolicy {
  maxEntries: number
  maxUnpackedBytes: number
}

export interface PreflightResult {
  entries: number
  unpackedBytes: number
}

type DeclaredEntry = { type: 'dir' } | { type: 'symlink'; target: string }

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Strips empty and `.` components. Callers that must forbid `..` do that separately via `assertRelativeNoTraversal` before calling this. */
function normalizeComponents(path: string): string[] {
  return path.split('/').filter((c) => c.length > 0 && c !== '.')
}

/** Rejects an absolute path, or one containing a literal `..` component. Used for entry names (every type) and hardlink targets — never for symlink targets, which legitimately use `..` to reach a sibling directory and are validated instead by resolving them through the virtual tree. */
function assertRelativeNoTraversal(path: string, what: string): void {
  if (path.startsWith('/')) throw new Error(`${what} is an absolute path: '${path}'`)
  if (path.split('/').includes('..'))
    throw new Error(`${what} contains a '..' path component: '${path}'`)
}

/** Rejects an entry whose parent directory chain passes through a path previously declared (in archive order) as a symlink. */
function assertParentNotSymlink(name: string, declared: ReadonlyMap<string, DeclaredEntry>): void {
  const parts = normalizeComponents(name)
  for (let i = 1; i < parts.length; i += 1) {
    const prefix = parts.slice(0, i).join('/')
    const entry = declared.get(prefix)
    if (entry !== undefined && entry.type === 'symlink') {
      throw new Error(`entry '${name}' has a parent path ('${prefix}') that is a symlink`)
    }
  }
}

/**
 * Resolves `targetSegments` starting from `startComponents` against the
 * virtual tree, following any previously-declared in-tree symlink whose path
 * the resolution passes through (bounded to `MAX_SYMLINK_DEPTH` hops, so a
 * symlink cycle fails closed instead of looping). Throws if the resolution
 * ever needs to pop past the tree root. Returns the final component stack —
 * the caller only needs to know that it resolved without escaping.
 */
function resolveContainedPath(
  startComponents: readonly string[],
  targetSegments: readonly string[],
  declared: ReadonlyMap<string, DeclaredEntry>,
): string[] {
  const current = [...startComponents]
  const remaining = [...targetSegments]
  let hops = 0
  for (;;) {
    const segment = remaining.shift()
    if (segment === undefined) break
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (current.length === 0) throw new Error('resolved path escapes the archive root')
      current.pop()
      continue
    }
    current.push(segment)
    const joined = current.join('/')
    const declaredEntry = declared.get(joined)
    if (declaredEntry !== undefined && declaredEntry.type === 'symlink') {
      hops += 1
      if (hops > MAX_SYMLINK_DEPTH) {
        throw new Error(
          `symlink chain exceeds the maximum depth (${MAX_SYMLINK_DEPTH}) at '${joined}'`,
        )
      }
      current.pop()
      remaining.unshift(...normalizeComponents(declaredEntry.target))
    }
  }
  return current
}

/**
 * Walks the full entry listing of a tar.gz artifact and decides, before any
 * extraction, whether it is safe to materialize (docs/adr/0013-signed-self-update.md;
 * issues/043-self-update.md). Simulates the resulting tree with a virtual map
 * of declared directories and symlinks built up in archive order, so
 * containment is judged against the same resolution order a real extraction
 * would apply. Throws a plain, specific `Error` on the first violation found;
 * returns totals only once the entire archive has been walked clean.
 */
export async function preflightArchive(
  filePath: string,
  policy: PreflightPolicy,
): Promise<PreflightResult> {
  const declared = new Map<string, DeclaredEntry>()
  let entries = 0
  let unpackedBytes = 0

  for await (const entry of readTarGzEntries(filePath)) {
    entries += 1
    if (entries > policy.maxEntries) {
      throw new Error(`archive exceeds the maximum allowed entry count (${policy.maxEntries})`)
    }

    assertRelativeNoTraversal(entry.name, `entry name '${entry.name}'`)
    assertParentNotSymlink(entry.name, declared)
    const normalizedName = normalizeComponents(entry.name).join('/')

    switch (entry.type) {
      case 'other':
        throw new Error(
          `archive contains an unsupported entry type (device, FIFO, socket, or unknown) at '${entry.name}'`,
        )

      case 'dir':
        declared.set(normalizedName, { type: 'dir' })
        break

      case 'symlink': {
        if (entry.linkName === undefined || entry.linkName.length === 0) {
          throw new Error(`symlink entry '${entry.name}' is missing a link target`)
        }
        if (entry.linkName.startsWith('/')) {
          throw new Error(`symlink '${entry.name}' has an absolute target: '${entry.linkName}'`)
        }
        const parentComponents = normalizedName
          .split('/')
          .slice(0, -1)
          .filter((c) => c.length > 0)
        try {
          resolveContainedPath(parentComponents, normalizeComponents(entry.linkName), declared)
        } catch (cause) {
          throw new Error(
            `symlink '${entry.name}' target '${entry.linkName}' escapes the archive root: ${messageOf(cause)}`,
          )
        }
        declared.set(normalizedName, { type: 'symlink', target: entry.linkName })
        break
      }

      case 'hardlink':
        if (entry.linkName === undefined || entry.linkName.length === 0) {
          throw new Error(`hardlink entry '${entry.name}' is missing a link target`)
        }
        assertRelativeNoTraversal(entry.linkName, `hardlink '${entry.name}' target`)
        break

      case 'file':
        unpackedBytes += entry.size
        if (unpackedBytes > policy.maxUnpackedBytes) {
          throw new Error(
            `archive exceeds the maximum allowed unpacked size (${policy.maxUnpackedBytes} bytes)`,
          )
        }
        break
    }
  }

  return { entries, unpackedBytes }
}

// --- Extraction ---------------------------------------------------------------

export interface ExtractVerifiedArchiveOptions {
  filePath: string
  destDir: string
  policy: PreflightPolicy
}

/**
 * Extracts a self-update artifact, but only after `preflightArchive` has
 * judged the full entry listing safe. `destDir` must not already exist —
 * this function creates it fresh at mode 0700, so nothing can have raced a
 * symlink or pre-existing file into the destination between preflight and
 * extraction.
 *
 * The actual byte-copying is delegated to the system `tar` binary
 * (`--no-same-owner`, since the daemon does not run as root). That is safe
 * specifically because the preflight is the security boundary, not `tar`
 * itself: the archive file is immutable for the whole call (it sits alone in
 * the caller's sha256-verified, privately-owned staging directory), so
 * whatever `preflightArchive` just proved about its contents still holds
 * when `tar` reads the same bytes moments later.
 */
export async function extractVerifiedArchive(
  options: ExtractVerifiedArchiveOptions,
): Promise<void> {
  const { filePath, destDir, policy } = options
  if (existsSync(destDir)) {
    throw new Error(`extraction destination already exists: ${destDir}`)
  }
  await preflightArchive(filePath, policy)
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  await execFileAsync('tar', ['-xzf', filePath, '--no-same-owner', '-C', destDir])
}
