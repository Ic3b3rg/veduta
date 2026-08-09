import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  ModelCatalogEntrySchema,
  ModelConnectionIdSchema,
  ModelConnectionMethodIdSchema,
  ModelConnectionSelectionSchema,
  ConnectionLifecycleStateSchema,
} from '@veduta/protocol'
import { backupFile, writeJsonAtomic } from './config-backup.ts'
import { SecretRefSchema } from './model-routing.ts'

/**
 * Model connections' durable store (issue #47, `docs/adr/0014-subscription-inference-boundary.md`):
 * `<rootDir>/connections.json` holds lifecycle state for every Model
 * connection. It never holds device-code challenge material — a login in
 * progress lives only in the registry's in-memory challenge map, so a
 * daemon restart drops it and boot normalization moves the record to
 * `failed` instead of resurrecting a stale login. Like `onboarding.json`
 * and `routing.json`, a corrupted file is never silently discarded:
 * `loadConnectionsConfig` throws instead of resetting, so a hand-edited or
 * truncated file surfaces as a clear error rather than quietly dropping
 * every connection.
 */
export const CONNECTIONS_FILE_NAME = 'connections.json'

/**
 * The daemon-side record for one Model connection — the protocol
 * `ModelConnectionSchema` shape minus the in-memory-only `challenge`, plus
 * `secretRef`: the vault or env reference this connection's API key
 * resolves through. Built explicitly here (not derived from the protocol
 * schema) because the two shapes diverge on exactly that field: the wire
 * shape must never carry a secret reference, and the on-disk record must
 * never carry challenge material.
 */
export const ModelConnectionRecordSchema = z
  .object({
    id: ModelConnectionIdSchema,
    method: ModelConnectionMethodIdSchema,
    provider: z.string().min(1),
    label: z.string().min(1),
    state: ConnectionLifecycleStateSchema,
    stateReason: z.string().optional(),
    stateAt: z.string(),
    enabledForFallback: z.boolean(),
    createdAt: z.string(),
    /** Vault or env reference this connection's API key resolves through; absent for Codex, which owns its own credential store under `CODEX_HOME`. */
    secretRef: SecretRefSchema.optional(),
    selectedModelId: z.string().min(1).optional(),
    catalog: z.array(ModelCatalogEntrySchema).optional(),
    catalogFetchedAt: z.string().optional(),
    account: z
      .object({ label: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()

export const ConnectionsFileSchema = z
  .object({
    version: z.literal(1).default(1),
    connections: z.array(ModelConnectionRecordSchema).default([]),
    selection: ModelConnectionSelectionSchema.optional(),
    /** Local VPS explicit development control — the only way a non-loopback profile may mock. */
    mockEnabled: z.boolean().default(false),
  })
  .strict()

export type ConnectionsFile = z.infer<typeof ConnectionsFileSchema>
export type ModelConnectionRecord = z.infer<typeof ModelConnectionRecordSchema>

function connectionsPath(rootDir: string): string {
  return join(rootDir, CONNECTIONS_FILE_NAME)
}

/** Absent file → no connections yet (`ConnectionsFileSchema.parse({})`). */
export function loadConnectionsConfig(rootDir: string): ConnectionsFile {
  const path = connectionsPath(rootDir)
  if (!existsSync(path)) return ConnectionsFileSchema.parse({})
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `invalid JSON in connections config ${path}: ${message} — refusing to silently reset Model connection state`,
    )
  }
  return ConnectionsFileSchema.parse(raw)
}

/**
 * Validates `file`, backs up the existing `connections.json` (if any), then
 * writes the new state atomically — the same discipline as
 * `saveRoutingConfig` (`model-routing.ts`).
 */
export function saveConnectionsConfig(rootDir: string, file: ConnectionsFile): void {
  const validated = ConnectionsFileSchema.parse(file)
  const path = connectionsPath(rootDir)
  backupFile(path)
  writeJsonAtomic(path, validated)
}

/**
 * Re-validates `id` against the protocol's `ModelConnectionIdSchema` before
 * it is used to build a filesystem path (`CODEX_HOME`), a vault entry name,
 * or a routing key. Every id already has to pass this schema to exist in
 * `connections.json`, but any id arriving from an HTTP request must be
 * re-checked at the point of use rather than trusted transitively.
 */
export function assertSafeConnectionId(id: string): void {
  if (!ModelConnectionIdSchema.safeParse(id).success) {
    throw new Error(`unsafe Model connection id: ${JSON.stringify(id)}`)
  }
}
