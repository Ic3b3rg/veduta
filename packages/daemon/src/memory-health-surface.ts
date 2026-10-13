import { SurfaceSchema, type JsonValue, type Surface } from '@veduta/protocol'
import { CharacterDocumentObserver } from './character-document-observer.ts'
import { characterDocumentBody } from './character-context.ts'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { statePatchOperations } from './system-surface-state.ts'

export const MEMORY_HEALTH_SURFACE_ID = 'srf-memory-health'
const DOCUMENT_LIMIT = 2000
const STALE_STATUS = 'Stale — memory source unavailable; showing last valid assessment'

/** A fixed catalog tree keeps a pinned projection live without replacing its presentation. */
function memoryHealthSurface(state: Record<string, JsonValue>, updatedAt: string): Surface {
  return SurfaceSchema.parse({
    id: MEMORY_HEALTH_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Memory health',
    presentation: 'full',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Memory health' } },
        {
          id: 'units',
          type: 'Caption',
          props: {
            text: 'Active FACTS and injected human documents, measured in UTF-16 units. Warnings do not block work.',
          },
        },
        {
          id: 'summary',
          type: 'Row',
          children: [
            { id: 'status', type: 'Stat', binding: 'status', props: { label: 'Status' } },
            {
              id: 'updated',
              type: 'Stat',
              binding: 'lastSuccessfulAt',
              props: { label: 'Last updated', valueFormat: 'datetime' },
            },
          ],
        },
        {
          id: 'budget',
          type: 'Row',
          children: ['low', 'high', 'hard'].map((key) => ({
            id: key,
            type: 'Stat',
            binding: key,
            props: { label: `${key[0]!.toUpperCase()}${key.slice(1)}`, unit: 'UTF-16 units' },
          })),
        },
        {
          id: 'spaces',
          type: 'Table',
          binding: 'spaces',
          props: {
            caption: 'Space memory',
            columns: [
              'space',
              'lifecycle',
              'activeUnits',
              'watermark',
              'reflection',
              'recovery',
              'assessedAt',
            ],
            columnFormats: { assessedAt: 'datetime' },
            emptyText: 'No user Spaces yet.',
          },
        },
        {
          id: 'documents',
          type: 'Table',
          binding: 'documents',
          props: {
            caption: 'Injected human documents',
            columns: ['document', 'scope', 'units', 'limit', 'status'],
          },
        },
        {
          id: 'injection',
          type: 'Caption',
          props: {
            text: 'USER is trimmed before injection. Recognized legacy Gateway policy and generated section wrappers are excluded. Archived Space INSTRUCTIONS are not injected.',
          },
        },
      ],
    },
    state,
    freshness: { updatedAt, updatedBy: 'system' },
  })
}

export class MemoryHealthSurfaceManager {
  private readonly store: Store
  private readonly now: () => Date
  private disposers: Array<() => void> = []
  private refreshing = false
  private documents: CharacterDocumentObserver | undefined

  constructor(options: { store: Store; now?: () => Date }) {
    this.store = options.store
    this.now = options.now ?? (() => new Date())
  }

  start(): void {
    if (this.disposers.length) return
    const engine = this.store.spacesEngine
    this.documents = new CharacterDocumentObserver(
      () => engine.characterDocumentPaths(),
      this.refresh,
    )
    this.disposers = [
      engine.onSpaceChanged(this.refresh),
      engine.onMemoryHealthChanged(this.refresh),
      engine.onMemoryWrite((notice) => {
        if (notice.spaceId !== SYSTEM_SPACE_ID) this.refresh()
      }),
    ]
    try {
      this.refresh()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  dispose(): void {
    this.documents?.dispose()
    this.documents = undefined
    for (const dispose of this.disposers) dispose()
    this.disposers = []
  }

  refresh = (): void => {
    if (this.refreshing || !this.documents) return
    this.refreshing = true
    try {
      const existing = this.store.getSurface(MEMORY_HEALTH_SURFACE_ID)
      if (
        existing &&
        (existing.spaceId !== SYSTEM_SPACE_ID || !this.store.isSurfaceDaemonOwned(existing.id))
      )
        throw new Error('memory health surface: refusing to adopt a noncanonical Surface')
      const updatedAt = this.now().toISOString()
      let state: Record<string, JsonValue>
      try {
        this.documents.reconcile()
        state = this.readState(updatedAt)
      } catch {
        state = existing
          ? { ...existing.state, status: STALE_STATUS }
          : {
              status: STALE_STATUS,
              lastSuccessfulAt: null,
              low: null,
              high: null,
              hard: null,
              spaces: [],
              documents: [],
            }
      }
      if (!existing) {
        this.store.createSurface(memoryHealthSurface(state, updatedAt), 'job', {
          daemonOwned: true,
        })
      } else if (statePatchOperations(existing.state, state, ['lastSuccessfulAt']).length) {
        this.store.patchState(existing.id, statePatchOperations(existing.state, state), {
          updatedBy: 'job',
        })
      }
    } finally {
      this.refreshing = false
    }
  }

  private readState(updatedAt: string): Record<string, JsonValue> {
    const engine = this.store.spacesEngine
    const allSpaces = engine.listAllSpaces()
    const spaces = allSpaces.filter((space) => space.id !== SYSTEM_SPACE_ID)
    for (const space of spaces) {
      if (!engine.memoryHealth().spaces[space.id]) engine.auditMemoryHealth(space.id)
    }
    const health = engine.memoryHealth()
    const docs = engine.readGlobalDocs()
    const document = (
      title: 'USER' | 'SOUL' | 'INSTRUCTIONS',
      body: string,
      scope: string,
      spaceName?: string,
    ) => {
      const units = characterDocumentBody(title, body, spaceName).length
      return {
        document: title,
        scope,
        units,
        limit: DOCUMENT_LIMIT,
        status: units > DOCUMENT_LIMIT ? 'Warning' : 'Within limit',
      }
    }
    return {
      status: 'Current',
      lastSuccessfulAt: updatedAt,
      low: health.budget.low,
      high: health.budget.high,
      hard: health.budget.hard,
      spaces: spaces.map((space) => {
        const assessment = health.spaces[space.id]!
        return {
          space: space.name,
          lifecycle: space.archived ? 'Archived' : 'Active',
          activeUnits: assessment.activeSize,
          watermark: assessment.watermark,
          reflection: assessment.reflectionPending ? 'Pending' : 'Not pending',
          recovery: assessment.overHardRecovery ? 'Over hard — recovery required' : 'Not required',
          assessedAt: assessment.updatedAt,
        }
      }),
      documents: [
        document('SOUL', docs.soul, 'Global'),
        document('USER', docs.user, 'Global'),
        ...allSpaces
          .filter((space) => !space.archived)
          .map((space) =>
            document('INSTRUCTIONS', engine.readInstructions(space.id), space.name, space.name),
          ),
      ],
    }
  }
}
