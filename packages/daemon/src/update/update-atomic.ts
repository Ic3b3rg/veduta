import { writeJsonAtomicDurable } from '../atomic-file.ts'

export { writeFileAtomicDurable } from '../atomic-file.ts'

/** Update-specific name for the shared durable JSON writer. */
export function writeJsonAtomic(path: string, data: unknown): void {
  writeJsonAtomicDurable(path, data)
}

/** Reporting state must never fail the update transaction it describes. */
export function writeJsonAtomicBestEffort(path: string, data: unknown): void {
  try {
    writeJsonAtomic(path, data)
  } catch {
    // Best-effort by design — see the doc comment above.
  }
}

/** Filesystem-safe ISO timestamp that preserves lexical time order. */
export function isoForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-')
}
