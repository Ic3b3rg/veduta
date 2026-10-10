import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { readEventsFile, type SpaceEvent } from './space-events.ts'

export interface PreparedSpaceEvent {
  event: SpaceEvent
  destination: string
}

/** A durable intent owns its Event identity; retries never append that Event twice. */
export function deliverDurableSpaceEvent(
  rootDir: string,
  prepared: PreparedSpaceEvent,
  identityKey: 'surfaceCommitId' | 'settingsMutationId',
): void {
  const path = resolve(rootDir, prepared.destination)
  if (!path.startsWith(`${resolve(rootDir)}${sep}`))
    throw new Error('Event destination escapes the data root')
  const id = prepared.event.payload?.[identityKey]
  if (typeof id !== 'string') throw new Error('Recoverable Event has no identity')
  const dir = dirname(path)
  const directoryExisted = existsSync(dir)
  if (!directoryExisted) mkdirSync(dir, { recursive: true })
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const alreadyAppended =
    existing.length > 0 && readEventsFile(path).some((event) => event.payload?.[identityKey] === id)
  const fd = openSync(path, 'a')
  try {
    if (!alreadyAppended) {
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
      const bytes = Buffer.from(`${prefix}${JSON.stringify(prepared.event)}\n`)
      for (let offset = 0; offset < bytes.length;)
        offset += writeSync(fd, bytes, offset, bytes.length - offset)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  syncDirectory(dir)
  if (!directoryExisted) syncDirectory(dirname(dir))
}

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
