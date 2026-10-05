import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PACKAGE_LIMITS, readPackageZip } from './package-zip.ts'

function archive(): Buffer {
  return readFileSync(new URL('./fixtures/clawhub/obsidian-1.0.0.zip', import.meta.url))
}

function centralOffset(bytes: Buffer): number {
  return bytes.readUInt32LE(bytes.length - 6)
}

describe('bounded package ZIP reader', () => {
  it('reads the published deterministic ZIP without filesystem extraction', () => {
    const files = readPackageZip(archive())
    expect([...files.keys()]).toEqual(['skill-card.md', 'SKILL.md', '_meta.json'])
    expect(files.get('SKILL.md')?.toString()).toContain('obsidian-cli')
  })

  it.each(['../escape_.md', '/secret___.md', 'c:\\escape_.md'])(
    'refuses escaping file paths %s',
    (path) => {
      const bytes = archive()
      const central = centralOffset(bytes)
      // Names have equal byte lengths so both headers stay structurally valid.
      expect(Buffer.byteLength(path)).toBe(bytes.readUInt16LE(central + 28))
      bytes.write(path, 30, 'utf8')
      bytes.write(path, central + 46, 'utf8')
      expect(() => readPackageZip(bytes)).toThrow('unsafe')
    },
  )

  it('refuses symlink entries even when their contents and hashes are valid', () => {
    const bytes = archive()
    bytes.writeUInt32LE(0xa1ff0000, centralOffset(bytes) + 38)
    expect(() => readPackageZip(bytes)).toThrow('unsafe')
  })

  it('refuses an advertised decompression bomb before expanding it', () => {
    const bytes = archive()
    bytes.writeUInt32LE(PACKAGE_LIMITS.fileBytes + 1, centralOffset(bytes) + 24)
    expect(() => readPackageZip(bytes)).toThrow('inspection limits')
  })

  it('refuses encrypted entries and unsupported compression', () => {
    for (const [field, value] of [
      [8, 9],
      [10, 99],
    ]) {
      const bytes = archive()
      bytes.writeUInt16LE(value!, centralOffset(bytes) + field!)
      expect(() => readPackageZip(bytes)).toThrow('unsafe')
    }
  })

  it('refuses corrupt contents, truncated headers, excess files and trailing data', () => {
    const corrupted = archive()
    corrupted[100] = corrupted[100]! ^ 0xff
    const excess = archive()
    excess.writeUInt16LE(PACKAGE_LIMITS.files + 1, excess.length - 12)
    for (const bytes of [
      corrupted,
      excess,
      archive().subarray(0, 500),
      Buffer.concat([archive(), Buffer.from('hidden')]),
    ])
      expect(() => readPackageZip(bytes)).toThrow()
  })
})
