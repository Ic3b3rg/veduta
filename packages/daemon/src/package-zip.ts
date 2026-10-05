import { inflateRawSync } from 'node:zlib'

export const PACKAGE_LIMITS = {
  archiveBytes: 1024 * 1024,
  fileBytes: 128 * 1024,
  totalBytes: 1024 * 1024,
  files: 64,
} as const

function refuse(): never {
  throw new Error('Package archive is invalid, unsafe, or exceeds inspection limits')
}

export function safePackagePath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 200 &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !/[\\:]/.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Reads bounded regular files in memory only; no package path reaches the filesystem. */
export function readPackageZip(bytes: Buffer): Map<string, Buffer> {
  if (bytes.length < 22 || bytes.length > PACKAGE_LIMITS.archiveBytes) refuse()
  // The supported deterministic catalog ZIP has no archive comment or ZIP64 records.
  const end = bytes.length - 22
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 20) !== 0
  )
    refuse()
  const count = bytes.readUInt16LE(end + 10)
  const centralSize = bytes.readUInt32LE(end + 12)
  const centralStart = bytes.readUInt32LE(end + 16)
  if (
    count === 0 ||
    count > PACKAGE_LIMITS.files ||
    bytes.readUInt16LE(end + 8) !== count ||
    centralStart + centralSize !== end
  )
    refuse()
  const files = new Map<string, Buffer>()
  let offset = centralStart
  let nextLocal = 0
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) refuse()
    const flags = bytes.readUInt16LE(offset + 8)
    const method = bytes.readUInt16LE(offset + 10)
    const checksum = bytes.readUInt32LE(offset + 16)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const size = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const attrs = bytes.readUInt32LE(offset + 38)
    const local = bytes.readUInt32LE(offset + 42)
    const nextCentral = offset + 46 + nameLength + extraLength + commentLength
    if (nextCentral > end || local !== nextLocal || local + 30 > centralStart) refuse()
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    total += size
    if (
      !safePackagePath(name) ||
      files.has(name) ||
      size > PACKAGE_LIMITS.fileBytes ||
      total > PACKAGE_LIMITS.totalBytes ||
      (flags & ~0x0808) !== 0 ||
      (method !== 0 && method !== 8) ||
      bytes.readUInt16LE(offset + 34) !== 0 ||
      (((attrs >>> 16) & 0xf000) !== 0 && ((attrs >>> 16) & 0xf000) !== 0x8000) ||
      (attrs & 0x10) !== 0 ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 26) !== nameLength ||
      !bytes.subarray(local + 30, local + 30 + nameLength).equals(nameBytes)
    )
      refuse()
    const start = local + 30 + nameLength + bytes.readUInt16LE(local + 28)
    const stop = start + compressedSize
    if (stop > centralStart) refuse()
    let body: Buffer
    try {
      body =
        method === 0
          ? bytes.subarray(start, stop)
          : inflateRawSync(bytes.subarray(start, stop), {
              maxOutputLength: PACKAGE_LIMITS.fileBytes,
            })
    } catch {
      refuse()
    }
    if (body.length !== size || crc32(body) !== checksum) refuse()
    if (flags & 8) {
      if (
        stop + 16 > centralStart ||
        bytes.readUInt32LE(stop) !== 0x08074b50 ||
        bytes.readUInt32LE(stop + 4) !== checksum ||
        bytes.readUInt32LE(stop + 8) !== compressedSize ||
        bytes.readUInt32LE(stop + 12) !== size
      )
        refuse()
      nextLocal = stop + 16
    } else {
      if (
        bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressedSize ||
        bytes.readUInt32LE(local + 22) !== size
      )
        refuse()
      nextLocal = stop
    }
    files.set(name, body)
    offset = nextCentral
  }
  if (offset !== end || nextLocal !== centralStart) refuse()
  return files
}
