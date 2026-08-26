import { SYSTEM_SPACE_ID } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { createFocusedAutomationTools } from './focused-automation-tools.ts'
import { renderFocusedStoredJson } from './focused-tool-support.ts'
import type { Scheduler } from './scheduler.ts'
import type { Store } from './store.ts'
import type { Origin } from './taint.ts'

const ListSurfacesSchema = z.object({})
const ReadSurfaceSchema = z.object({ surfaceId: z.string().min(1) })

export interface SystemChatToolsOptions {
  store: Store
  scheduler: Scheduler
}

/** One non-disclosing refusal for content outside the safe System status reader. */
export class SystemStatusReadError extends Error {
  constructor() {
    super('System status Surface is unavailable')
    this.name = 'SystemStatusReadError'
  }
}

/**
 * The complete System-scoped registry. New Gateway operations must be added
 * explicitly here; ordinary Surface, memory, Template, Automation-authoring,
 * outbound, and Worker tools never enter this branch by default.
 */
export function createSystemChatTools(options: SystemChatToolsOptions): ToolDef[] {
  const listAutomations = createFocusedAutomationTools({
    scheduler: options.scheduler,
    spaceId: SYSTEM_SPACE_ID,
  }).find((tool) => tool.name === 'list_automations')
  if (!listAutomations) throw new Error('System chat requires the Automation status reader')

  return [
    defineTool({
      name: 'list_surfaces',
      description: 'List compact summaries of daemon-owned System status Surfaces.',
      schema: ListSurfacesSchema,
      level: 'L0',
      egressDomains: [],
      handler() {
        const surfaces = systemStatusSurfaces(options.store)
        const summaries = surfaces.map((surface) => ({
          id: surface.id,
          title: surface.title,
          freshness: surface.freshness,
          pinned: surface.pinned ?? false,
        }))
        const origins = surfaceOrigins(
          options.store,
          surfaces.map((surface) => surface.id),
        )
        return {
          content: renderFocusedStoredJson(summaries, origins, 'System status summaries'),
          details: { surfaces: summaries },
          origins,
        }
      },
    }),
    defineTool({
      name: 'read_surface',
      description:
        'Read one complete daemon-owned System status Surface without granting authoring access.',
      schema: ReadSurfaceSchema,
      level: 'L0',
      egressDomains: [],
      handler(input) {
        const surface = systemStatusSurfaces(options.store).find(
          (candidate) => candidate.id === input.surfaceId,
        )
        if (!surface) throw new SystemStatusReadError()
        const version = options.store.getSurfaceVersion(surface.id)
        if (!version) throw new SystemStatusReadError()
        const origins = surfaceOrigins(options.store, [surface.id])
        const details = { surface, ...version }
        return {
          content: renderFocusedStoredJson(details, origins, 'System status Surface'),
          details,
          origins,
        }
      },
    }),
    listAutomations,
  ]
}

function systemStatusSurfaces(store: Store) {
  return store
    .listSurfaces(SYSTEM_SPACE_ID)
    .filter((surface) => store.isSurfaceDaemonOwned(surface.id))
}

function surfaceOrigins(store: Store, surfaceIds: string[]): Origin[] {
  return Array.from(
    new Set(
      surfaceIds.map(
        (surfaceId) => store.surfaceProvenance(surfaceId)?.contentOrigin ?? 'trusted:system',
      ),
    ),
  )
}
