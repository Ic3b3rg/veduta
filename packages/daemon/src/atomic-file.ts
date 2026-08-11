import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Durably replaces one file through a uniquely named, same-directory temporary file. */
export function writeFileAtomicDurable(path: string, content: Buffer, mode = 0o600): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
  let fd: number | undefined
  try {
    fd = openSync(tmpPath, 'wx', mode)
    writeFileSync(fd, content)
    fchmodSync(fd, mode)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(tmpPath, { force: true })
    throw error
  }

  const dirFd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Pretty-JSON convenience wrapper for durable mode-0600 state files. */
export function writeJsonAtomicDurable(path: string, value: unknown): void {
  writeFileAtomicDurable(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}
