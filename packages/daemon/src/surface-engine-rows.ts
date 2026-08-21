import {
  AtomNodeSchema,
  JsonObjectSchema,
  PatchOperationSchema,
  SurfaceArchivedEventSchema,
  SurfaceCreatedEventSchema,
  SurfaceMovedEventSchema,
  SurfacePatchEventSchema,
  SurfacePinnedEventSchema,
  SurfaceSchema,
  type Surface,
} from '@veduta/protocol'
import { z } from 'zod'
import type { QueuedAgentTurn, SurfaceEngineEvent, TreeProposal } from './surface-engine.ts'
import { optionalString, requiredNumber, requiredString } from './sqlite-rows.ts'
import { isValidOrigin } from './taint.ts'

export function surfaceFromRow(row: Record<string, unknown>): Surface {
  const validity = optionalString(row, 'validity_json')
  return SurfaceSchema.parse({
    id: requiredString(row, 'id'),
    spaceId: requiredString(row, 'space_id'),
    title: requiredString(row, 'title'),
    tree: JSON.parse(requiredString(row, 'tree_json')),
    state: JSON.parse(requiredString(row, 'state_json')),
    freshness: {
      updatedAt: requiredString(row, 'updated_at'),
      updatedBy: requiredString(row, 'updated_by'),
    },
    pinned: requiredNumber(row, 'pinned') === 1,
    // Daemon-owned Surfaces are never pinnable, so clients do not render a
    // toggle for a mutation the daemon would refuse.
    pinnable: requiredNumber(row, 'daemon_owned') === 0,
    ...(validity === undefined ? {} : { validity: JSON.parse(validity) }),
  })
}

/**
 * Exported for the hermetic replay in `update/self-check.ts`. Sharing this
 * parser prevents the self-check and normal boot replay from drifting apart.
 */
export function surfaceEngineEventFromRow(row: Record<string, unknown>): SurfaceEngineEvent {
  const kind = requiredString(row, 'kind')
  const rawJson = JSON.parse(requiredString(row, 'event_json'))
  const json =
    kind === 'created' || kind === 'archived' || kind === 'pinned'
      ? withOrderFallback(rawJson)
      : rawJson
  if (kind === 'created') return { kind: 'created', event: SurfaceCreatedEventSchema.parse(json) }
  if (kind === 'archived') {
    return { kind: 'archived', event: SurfaceArchivedEventSchema.parse(json) }
  }
  if (kind === 'patch') {
    return { kind: 'patch', event: SurfacePatchEventSchema.parse(withFreshnessFallback(json)) }
  }
  if (kind === 'pinned') {
    return { kind: 'pinned', event: SurfacePinnedEventSchema.parse(withFreshnessFallback(json)) }
  }
  if (kind === 'moved') {
    return { kind: 'moved', event: SurfaceMovedEventSchema.parse(json) }
  }
  throw new Error(`unknown surface_events kind: ${kind}`)
}

/**
 * Surface lifecycle rows written before Gateway-owned ordering have no
 * authoritative order payload. A fresh canonical snapshot is the upgrade
 * boundary; replay keeps those historical rows readable with an empty,
 * no-op order while all newly written rows remain strict on the wire.
 */
function withOrderFallback(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json
  if ('order' in json || !('cursor' in json) || !('spaceId' in json)) return json
  const record = json as Record<string, unknown>
  return {
    ...record,
    order: {
      cursor: record['cursor'],
      spaceId: record['spaceId'],
      pinnedSurfaceIds: [],
      regularSurfaceIds: [],
    },
  }
}

/**
 * Legacy patch and pin rows can predate mandatory freshness metadata. The
 * durable reader synthesizes it from the event timestamp while wire schemas
 * remain strict. Malformed metadata is never repaired silently. This is the
 * two-data-regimes policy described in `docs/adr/0013-signed-self-update.md`.
 */
function withFreshnessFallback(json: unknown): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json
  if ('freshness' in json) return json
  const at = (json as Record<string, unknown>)['at']
  const updatedAt =
    typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : '1970-01-01T00:00:00.000Z'
  return { ...json, freshness: { updatedAt, updatedBy: 'system' } }
}

export function treeProposalFromRow(row: Record<string, unknown>): TreeProposal {
  const status = requiredString(row, 'status')
  if (
    status !== 'pending' &&
    status !== 'accepted' &&
    status !== 'rejected' &&
    status !== 'stale'
  ) {
    throw new Error(`unknown tree_proposals status: ${status}`)
  }
  const storedOrigin = requiredString(row, 'origin')
  const resolvedAt = optionalString(row, 'resolved_at')
  const resolvedBy = optionalString(row, 'resolved_by')
  if (resolvedBy !== undefined && resolvedBy !== 'trusted:user') {
    throw new Error(`unknown tree_proposals resolved_by: ${resolvedBy}`)
  }
  return {
    id: requiredNumber(row, 'id'),
    surfaceId: requiredString(row, 'surface_id'),
    spaceId: requiredString(row, 'space_id'),
    operations: z
      .array(PatchOperationSchema)
      .parse(JSON.parse(requiredString(row, 'operations_json'))),
    expectedTreeVersion: requiredNumber(row, 'expected_tree_version'),
    origin: isValidOrigin(storedOrigin) ? storedOrigin : 'trusted:system',
    status,
    createdAt: requiredString(row, 'created_at'),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
  }
}

export function agentTurnFromRow(row: Record<string, unknown>): QueuedAgentTurn {
  const id = requiredNumber(row, 'id')
  return {
    id: `agent-turn-${id}`,
    at: requiredString(row, 'at'),
    spaceId: requiredString(row, 'space_id'),
    surfaceId: requiredString(row, 'surface_id'),
    atomId: requiredString(row, 'atom_id'),
    actionName: requiredString(row, 'action_name'),
    payload: JsonObjectSchema.parse(JSON.parse(requiredString(row, 'payload_json'))),
    surface: SurfaceSchema.parse(JSON.parse(requiredString(row, 'surface_json'))),
    atom: AtomNodeSchema.parse(JSON.parse(requiredString(row, 'atom_json'))),
  }
}
