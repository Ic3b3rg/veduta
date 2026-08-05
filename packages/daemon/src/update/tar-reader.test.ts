import { execFile } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractVerifiedArchive,
  preflightArchive,
  readTarEntries,
  type PreflightPolicy,
  type TarEntry,
} from './tar-reader.ts'

/**
 * `tar-reader.ts` (issues/043-self-update.md): a structured tar-header
 * reader plus the containment preflight that decides an update artifact is
 * safe before any extraction. The adversarial cases below craft raw tar
 * bytes with the header builder at the bottom of this file rather than
 * relying on any real `tar` binary to produce malicious layouts — a real
 * tar CLI generally refuses to write the very archives being tested for
 * (absolute paths, `..` components, device nodes). Only the benign case
 * shells out to the system `tar` to prove interop with a real-world
 * artifact.
 */

const execFileAsync = promisify(execFile)

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

function writeArchive(entries: Buffer[]): string {
  const raw = Buffer.concat([...entries, Buffer.alloc(1024)])
  const dir = freshDir('tar-reader-')
  const path = join(dir, 'artifact.tar.gz')
  writeFileSync(path, gzipSync(raw))
  return path
}

const GENEROUS_POLICY: PreflightPolicy = { maxEntries: 10_000, maxUnpackedBytes: 100_000_000 }

// --- Raw tar header builder (test-only) --------------------------------------
//
// Builds a single 512-byte ustar header with a correctly computed checksum:
// the sum of every header byte, with the 8-byte checksum field itself
// treated as spaces while summing, encoded as 6 octal digits followed by a
// NUL and a trailing space.

interface HeaderFields {
  name: string
  typeflag: string
  linkname?: string
  size?: number
  prefix?: string
}

function writeField(buf: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, 'utf8')
  bytes.copy(buf, offset, 0, Math.min(bytes.length, length))
}

function writeOctalField(buf: Buffer, value: number, offset: number, length: number): void {
  const digits = Math.max(length - 1, 1)
  const octal = value.toString(8).padStart(digits, '0')
  buf.write(octal, offset, digits, 'latin1')
}

function buildTarHeader(fields: HeaderFields): Buffer {
  const buf = Buffer.alloc(512)
  writeField(buf, fields.name, 0, 100)
  writeOctalField(buf, 0o644, 100, 8) // mode
  writeOctalField(buf, 0, 108, 8) // uid
  writeOctalField(buf, 0, 116, 8) // gid
  writeOctalField(buf, fields.size ?? 0, 124, 12) // size
  writeOctalField(buf, 0, 136, 12) // mtime
  buf.write('        ', 148, 8, 'latin1') // chksum placeholder: 8 spaces
  buf.write(fields.typeflag, 156, 1, 'latin1')
  writeField(buf, fields.linkname ?? '', 157, 100)
  buf.write('ustar\0', 257, 6, 'latin1')
  buf.write('00', 263, 2, 'latin1')
  writeField(buf, fields.prefix ?? '', 345, 155)

  let sum = 0
  for (const byte of buf) sum += byte
  const chksum = sum.toString(8).padStart(6, '0')
  buf.write(`${chksum}\0 `, 148, 8, 'latin1')
  return buf
}

function padTo512(buf: Buffer): Buffer {
  const remainder = buf.length % 512
  return remainder === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - remainder)])
}

function fileEntry(name: string, content: string): Buffer {
  const data = Buffer.from(content, 'utf8')
  return Buffer.concat([buildTarHeader({ name, typeflag: '0', size: data.length }), padTo512(data)])
}

function dirEntry(name: string): Buffer {
  const normalized = name.endsWith('/') ? name : `${name}/`
  return buildTarHeader({ name: normalized, typeflag: '5' })
}

function symlinkEntry(name: string, target: string): Buffer {
  return buildTarHeader({ name, typeflag: '2', linkname: target })
}

function hardlinkEntry(name: string, target: string): Buffer {
  return buildTarHeader({ name, typeflag: '1', linkname: target })
}

function deviceEntry(name: string): Buffer {
  return buildTarHeader({ name, typeflag: '3' })
}

/** A PAX record: `<decimal length> key=value\n`, where `length` covers the whole record including itself — the self-referential length calculation converges because the digit count of `length` only ever grows. */
function paxRecord(key: string, value: string): Buffer {
  let len = key.length + value.length + 3 // ' ' + '=' + '\n'
  for (;;) {
    const candidate = `${len} ${key}=${value}\n`
    if (candidate.length === len) return Buffer.from(candidate, 'utf8')
    len = candidate.length
  }
}

function extendedHeaderEntry(typeflag: 'x' | 'g', records: Buffer[]): Buffer {
  const data = Buffer.concat(records)
  return Buffer.concat([
    buildTarHeader({ name: 'pax_header', typeflag, size: data.length }),
    padTo512(data),
  ])
}

function paxHeaderEntry(records: Buffer[]): Buffer {
  return extendedHeaderEntry('x', records)
}

function gnuLongNameEntry(longName: string): Buffer {
  const data = Buffer.concat([Buffer.from(longName, 'utf8'), Buffer.from([0])])
  return Buffer.concat([
    buildTarHeader({ name: './@LongLink', typeflag: 'L', size: data.length }),
    padTo512(data),
  ])
}

// --- 1. benign tree -----------------------------------------------------------

describe('preflightArchive and extractVerifiedArchive: benign tree', () => {
  it('passes preflight, extracts, and preserves a relative in-tree symlink (pnpm-style layout)', async () => {
    const srcDir = freshDir('tar-reader-src-')
    writeFileSync(join(srcDir, 'a.txt'), 'hello')
    mkdirSync(join(srcDir, 'dir'), { recursive: true })
    writeFileSync(join(srcDir, 'dir', 'b.txt'), 'world')
    mkdirSync(join(srcDir, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo'), {
      recursive: true,
    })
    writeFileSync(
      join(srcDir, 'node_modules', '.pnpm', 'foo@1.0.0', 'node_modules', 'foo', 'index.js'),
      'module.exports = {}',
    )
    symlinkSync('.pnpm/foo@1.0.0/node_modules/foo', join(srcDir, 'node_modules', 'foo'))

    const outDir = freshDir('tar-reader-out-')
    const archivePath = join(outDir, 'artifact.tar.gz')
    await execFileAsync('tar', ['-czf', archivePath, '-C', srcDir, '.'])

    const result = await preflightArchive(archivePath, GENEROUS_POLICY)
    expect(result.entries).toBeGreaterThan(0)
    expect(result.unpackedBytes).toBeGreaterThan(0)

    const destDir = join(outDir, 'extracted')
    await extractVerifiedArchive({ filePath: archivePath, destDir, policy: GENEROUS_POLICY })

    const symlinkPath = join(destDir, 'node_modules', 'foo')
    expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(symlinkPath)).toBe('.pnpm/foo@1.0.0/node_modules/foo')

    // 13. post-extraction belt-and-braces: every extracted entry's realpath stays under destDir.
    const destRoot = realpathSync(destDir)
    for (const relPath of ['a.txt', 'dir/b.txt', 'node_modules/foo', 'node_modules/foo/index.js']) {
      const resolved = realpathSync(join(destDir, relPath))
      expect(resolved === destRoot || resolved.startsWith(destRoot + sep)).toBe(true)
    }
  })
})

// --- 2-9, 11: adversarial preflight rejections --------------------------------

describe('preflightArchive: containment rejections', () => {
  it('2. rejects an absolute entry name', async () => {
    const archivePath = writeArchive([fileEntry('/etc/passwd', 'pwned')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(/absolute path/)
  })

  it('3. rejects a ".." path component', async () => {
    const archivePath = writeArchive([fileEntry('../outside.txt', 'pwned')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(
      /'\.\.' path component/,
    )
  })

  it('4. rejects symlink-then-write-through (absolute target, then a write inside it)', async () => {
    const archivePath = writeArchive([symlinkEntry('evil', '/tmp'), fileEntry('evil/x', 'pwned')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(/absolute target/)
  })

  it('5. rejects an escaping relative symlink target', async () => {
    const archivePath = writeArchive([dirEntry('a'), symlinkEntry('a/link', '../../outside')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(
      /escapes the archive root/,
    )
  })

  it('6. rejects an escaping hardlink', async () => {
    const archivePath = writeArchive([hardlinkEntry('evil', '../outside')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(
      /'\.\.' path component/,
    )
  })

  it('7. rejects a device node', async () => {
    const archivePath = writeArchive([deviceEntry('dev-null')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(
      /unsupported entry type/,
    )
  })

  it('8. rejects an entry-count bomb', async () => {
    const entries = Array.from({ length: 20 }, (_, i) => dirEntry(`dir-${i}`))
    const archivePath = writeArchive(entries)
    const policy: PreflightPolicy = { maxEntries: 10, maxUnpackedBytes: 100_000_000 }
    await expect(preflightArchive(archivePath, policy)).rejects.toThrow(
      /maximum allowed entry count/,
    )
  })

  it('9. rejects a size bomb', async () => {
    const archivePath = writeArchive([fileEntry('big.bin', 'A'.repeat(2000))])
    const policy: PreflightPolicy = { maxEntries: 10_000, maxUnpackedBytes: 1000 }
    await expect(preflightArchive(archivePath, policy)).rejects.toThrow(
      /maximum allowed unpacked size/,
    )
  })

  it('11. handles a GNU long name ("L") entry applying to the next entry', async () => {
    const longName = `deep/${'segment/'.repeat(20)}file.txt`
    const archivePath = writeArchive([
      gnuLongNameEntry(longName),
      fileEntry('placeholder.txt', 'content'),
    ])
    const result = await preflightArchive(archivePath, GENEROUS_POLICY)
    expect(result.entries).toBe(1)
    expect(result.unpackedBytes).toBe('content'.length)
  })

  it('also rejects a parent path that traverses a previously-declared symlink even without a write directly through it', async () => {
    const archivePath = writeArchive([symlinkEntry('link', 'somewhere'), dirEntry('link/nested')])
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(/parent path/)
  })
})

// --- 10. newline-poisoned names via PAX path override -------------------------

describe('newline in an entry name (PAX "path" override): no text-parsing ambiguity', () => {
  it('parses a benign newline-containing name as a single entry, and preflight accepts it', async () => {
    const poisonedName = 'evil\nnot-a-second-entry.txt'
    const rawEntries = [
      paxHeaderEntry([paxRecord('path', poisonedName)]),
      fileEntry('placeholder.txt', 'x'),
    ]

    const collected: TarEntry[] = []
    for await (const entry of readTarEntries(Buffer.concat(rawEntries))) collected.push(entry)
    expect(collected).toHaveLength(1)
    expect(collected[0]?.name).toBe(poisonedName)

    const archivePath = writeArchive(rawEntries)
    const result = await preflightArchive(archivePath, GENEROUS_POLICY)
    expect(result.entries).toBe(1)
  })

  it('still rejects a newline-poisoned name that also carries a ".." component', async () => {
    const poisonedName = 'evil\n../../etc/passwd'
    const rawEntries = [
      paxHeaderEntry([paxRecord('path', poisonedName)]),
      fileEntry('placeholder.txt', 'x'),
    ]
    const archivePath = writeArchive(rawEntries)
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(
      /'\.\.' path component/,
    )
  })
})

// --- PAX size override vs. raw header size disagreement -----------------------

describe('readTarEntries / preflightArchive: PAX size override disagreement', () => {
  it('rejects a PAX "size" override that disagrees with the raw header size field', async () => {
    const rawEntries = [
      paxHeaderEntry([paxRecord('size', '50')]),
      fileEntry('small.txt', 'x'.repeat(10)), // header.size = 10, disagrees with the PAX override
    ]
    const archivePath = writeArchive(rawEntries)
    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(/disagrees/)
  })

  it('accepts a PAX "size" override that matches the raw header size field', async () => {
    const rawEntries = [
      paxHeaderEntry([paxRecord('size', '10')]),
      fileEntry('small.txt', 'x'.repeat(10)),
    ]
    const archivePath = writeArchive(rawEntries)
    const result = await preflightArchive(archivePath, GENEROUS_POLICY)
    expect(result.entries).toBe(1)
    expect(result.unpackedBytes).toBe(10)
  })

  it('refuses the hidden-traversal-after-fake-EOF construction, and materializes nothing', async () => {
    // A file entry declares a raw header size of 0 but a PAX size override of
    // 1024 (two blocks). If a reader skipped the entry's payload using the
    // raw header size (0, the bug this test guards against), it would treat
    // the next two 512-byte blocks of that "hidden" payload as a two-zero-block
    // tar terminator and stop there -- never reaching the malicious traversal
    // entry that a real `tar` extractor, honoring the PAX size, would read
    // immediately after skipping the full 1024-byte payload.
    const hiddenPayload = Buffer.alloc(1024) // two all-zero blocks
    const fakeZeroSizeFile = Buffer.concat([
      buildTarHeader({ name: 'placeholder.bin', typeflag: '0', size: 0 }),
      hiddenPayload,
    ])
    const rawEntries = [
      paxHeaderEntry([paxRecord('size', '1024')]),
      fakeZeroSizeFile,
      fileEntry('../../etc/passwd', 'pwned'),
    ]
    const archivePath = writeArchive(rawEntries)

    await expect(preflightArchive(archivePath, GENEROUS_POLICY)).rejects.toThrow(/disagrees/)

    const outDir = freshDir('tar-reader-hidden-traversal-')
    const destDir = join(outDir, 'dest')
    await expect(
      extractVerifiedArchive({ filePath: archivePath, destDir, policy: GENEROUS_POLICY }),
    ).rejects.toThrow(/disagrees/)
    expect(existsSync(destDir)).toBe(false)
  })
})

// --- PAX global header rejection ----------------------------------------------

describe('readTarEntries: PAX global header', () => {
  it('rejects a "g" typeflag PAX global header outright', async () => {
    const rawEntries = [
      extendedHeaderEntry('g', [paxRecord('comment', 'x')]),
      fileEntry('placeholder.txt', 'x'),
    ]
    async function drain(): Promise<void> {
      for await (const _entry of readTarEntries(Buffer.concat(rawEntries))) {
        // draining is enough to trigger the rejection
      }
    }
    await expect(drain()).rejects.toThrow(/PAX global extended header/)
  })
})

// --- 12. extractVerifiedArchive refuses an existing destDir ------------------

describe('extractVerifiedArchive: destDir safety', () => {
  it('12. refuses to extract into an already-existing destDir', async () => {
    const archivePath = writeArchive([fileEntry('a.txt', 'hello')])
    const outDir = freshDir('tar-reader-existing-')
    const destDir = join(outDir, 'dest')
    mkdirSync(destDir)
    await expect(
      extractVerifiedArchive({ filePath: archivePath, destDir, policy: GENEROUS_POLICY }),
    ).rejects.toThrow(/already exists/)
  })

  it('performs no filesystem mutation when preflight rejects the archive', async () => {
    const archivePath = writeArchive([fileEntry('/etc/passwd', 'pwned')])
    const outDir = freshDir('tar-reader-refused-')
    const destDir = join(outDir, 'dest')
    await expect(
      extractVerifiedArchive({ filePath: archivePath, destDir, policy: GENEROUS_POLICY }),
    ).rejects.toThrow(/absolute path/)
    expect(existsSync(destDir)).toBe(false)
  })
})
