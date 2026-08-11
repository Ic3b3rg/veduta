import { readFileSync } from 'node:fs'

export interface JsonFileDescription {
  description: string
  refusal?: string
}

/** Reads JSON with a consistent path-aware error while leaving schema validation to the caller. */
export function readJsonFile(path: string, options: JsonFileDescription): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const refusal = options.refusal === undefined ? '' : ` — ${options.refusal}`
    throw new Error(`invalid JSON in ${options.description} ${path}: ${detail}${refusal}`)
  }
}
