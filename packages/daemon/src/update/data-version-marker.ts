import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeJsonAtomicDurable } from '../atomic-file.ts'

const DataVersionMarkerSchema = z.object({
  dataVersion: z.number().int().nonnegative(),
})

function markerPath(rootDir: string): string {
  return join(rootDir, 'data-version.json')
}

export function readDataVersion(rootDir: string): number | undefined {
  const path = markerPath(rootDir)
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`${path} is corrupt: not valid JSON`)
  }
  const parsed = DataVersionMarkerSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`${path} is corrupt: expected {"dataVersion": <number>}`)
  return parsed.data.dataVersion
}

export function stampDataVersion(rootDir: string, dataVersion: number): void {
  writeJsonAtomicDurable(markerPath(rootDir), DataVersionMarkerSchema.parse({ dataVersion }))
}
