import { createHash } from 'node:crypto'
import { canonicalJson } from '@veduta/protocol'

/** Configuration comparison shared by Settings reads and conditional writes. */
export function settingsRevision(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
