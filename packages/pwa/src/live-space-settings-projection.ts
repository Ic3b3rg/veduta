import type {
  RenderableSpaceSettings,
  SpaceSettingsCommand,
  SpaceSettingsList,
} from '@veduta/protocol'
import type * as Api from './space-settings-api.ts'

type Resource = 'list' | `space:${string}`
export interface LiveSpaceSettingsSnapshot {
  readonly list: SpaceSettingsList | undefined
  readonly details: Readonly<Record<string, RenderableSpaceSettings>>
  readonly loading: readonly Resource[]
  readonly errors: Readonly<Partial<Record<Resource, string>>>
}

/** Runtime-owned Settings reads and commands; React retains only selection and editing drafts. */
export class LiveSpaceSettingsProjection {
  private list: SpaceSettingsList | undefined
  private details: Record<string, RenderableSpaceSettings> = {}
  private loading: Resource[] = []
  private errors: Partial<Record<Resource, string>> = {}
  private readonly loaded = new Set<Resource>()
  private readonly pending = new Map<Resource, Promise<void>>()
  private readonly requested = new Set<Resource>()
  private readonly revisions = new Map<Resource, number>()
  private epoch = 0
  private sessionEpoch = 0

  constructor(
    private readonly owner: {
      api: typeof Api
      token: () => string | undefined
      active: () => boolean
      publish: () => void
      authenticationFailure: (error: unknown) => void
    },
  ) {}

  snapshot(): LiveSpaceSettingsSnapshot {
    return { list: this.list, details: this.details, loading: this.loading, errors: this.errors }
  }

  cancel(): void {
    this.epoch += 1
    this.pending.clear()
    this.requested.clear()
    this.loading = []
  }

  clear(): void {
    this.cancel()
    this.sessionEpoch += 1
    this.list = undefined
    this.details = {}
    this.errors = {}
  }

  loadList(): Promise<void> {
    this.loaded.add('list')
    return this.read('list')
  }

  load(spaceId: string): Promise<void> {
    const key: Resource = `space:${spaceId}`
    this.loaded.add(key)
    return this.read(key)
  }

  refresh(): void {
    for (const key of this.loaded) void this.read(key)
  }

  invalidate(spaceId: string): void {
    if (this.loaded.has('list')) void this.read('list')
    const key: Resource = `space:${spaceId}`
    if (this.loaded.has(key)) void this.read(key)
  }

  private supersede(key: Resource): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
  }

  private clearError(key: Resource): void {
    const errors = { ...this.errors }
    delete errors[key]
    this.errors = errors
  }

  private read(key: Resource): Promise<void> {
    if (!this.owner.active()) return Promise.resolve()
    const existing = this.pending.get(key)
    if (existing) {
      this.requested.add(key)
      return existing
    }
    const epoch = this.epoch
    const revision = this.revisions.get(key)
    this.loading = [...this.loading, key]
    this.owner.publish()
    const work = (async () => {
      try {
        if (key === 'list') {
          const result = await this.owner.api.fetchSpaceSettingsList(this.owner.token())
          if (epoch !== this.epoch || revision !== this.revisions.get(key)) return
          this.list = result
        } else {
          const spaceId = key.slice('space:'.length)
          const result = await this.owner.api.fetchSpaceSettings(spaceId, this.owner.token())
          if (epoch !== this.epoch || revision !== this.revisions.get(key)) return
          this.details = { ...this.details, [spaceId]: result }
        }
        this.clearError(key)
      } catch (error) {
        if (epoch !== this.epoch || revision !== this.revisions.get(key)) return
        this.errors = {
          ...this.errors,
          [key]: error instanceof Error ? error.message : 'Settings could not load',
        }
        this.owner.authenticationFailure(error)
      } finally {
        if (epoch === this.epoch) {
          this.pending.delete(key)
          this.loading = this.loading.filter((resource) => resource !== key)
          this.owner.publish()
          if (this.requested.delete(key)) void this.read(key)
        }
      }
    })()
    this.pending.set(key, work)
    return work
  }

  async change(spaceId: string, command: SpaceSettingsCommand): Promise<RenderableSpaceSettings> {
    const epoch = this.sessionEpoch
    const key: Resource = `space:${spaceId}`
    this.supersede(key)
    this.supersede('list')
    try {
      const result = await this.owner.api.changeSpaceSettings(spaceId, command, this.owner.token())
      if (epoch !== this.sessionEpoch || !this.owner.active())
        throw new Error('The Settings session changed. Reload to confirm the saved state.')
      this.supersede(key)
      this.supersede('list')
      this.details = { ...this.details, [spaceId]: result }
      this.clearError(key)
      if (this.list)
        this.list = {
          ...this.list,
          spaces: this.list.spaces.map((space) => (space.id === spaceId ? result.space : space)),
        }
      this.owner.publish()
      // The mutation receipt is authoritative even if later reconciliation fails.
      void this.read(key)
      if (this.loaded.has('list')) void this.read('list')
      return result
    } catch (error) {
      if (epoch === this.sessionEpoch) {
        this.owner.authenticationFailure(error)
        if (epoch === this.sessionEpoch) void this.read(key)
      }
      throw error
    }
  }

  async changeReflection(
    change: Parameters<typeof Api.changeReflectionSettings>[0],
  ): Promise<SpaceSettingsList> {
    const epoch = this.sessionEpoch
    this.supersede('list')
    try {
      const result = await this.owner.api.changeReflectionSettings(change, this.owner.token())
      if (epoch !== this.sessionEpoch || !this.owner.active())
        throw new Error('The Settings session changed. Reload to confirm the saved state.')
      this.supersede('list')
      this.list = result
      this.clearError('list')
      this.owner.publish()
      for (const key of this.loaded)
        if (key !== 'list') {
          this.supersede(key)
          void this.read(key)
        }
      return result
    } catch (error) {
      if (epoch === this.sessionEpoch) {
        this.owner.authenticationFailure(error)
        if (epoch === this.sessionEpoch) void this.read('list')
      }
      throw error
    }
  }
}
