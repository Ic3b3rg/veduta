import { join } from 'node:path'
import {
  SpaceSettingsSchema,
  SpaceSettingsListSchema,
  SpaceSettingsCommandSchema,
  ReflectionSettingsChangeSchema,
  SYSTEM_SPACE_ID,
  type SpaceSettings,
  type SpaceSettingsList,
  type SpaceSettingsCommand,
} from '@veduta/protocol'
import type { z } from 'zod'
import { writeJsonAtomicDurable } from './atomic-file.ts'
import type { Store } from './store.ts'
import type { Scheduler } from './scheduler.ts'
import type { Reflection } from './reflection.ts'
import type { MemoryConfig } from './memory-config.ts'
import { settingsRevision } from './settings-revision.ts'

export class SpaceSettingsService {
  constructor(
    private readonly deps: {
      store: Store
      scheduler: Scheduler
      reflection: Pick<Reflection, 'reconcileJobs'>
      memoryConfig: MemoryConfig
    },
  ) {}

  list(): SpaceSettingsList {
    const config = this.deps.memoryConfig
    const enabled =
      config.reflection.enabled &&
      this.deps.scheduler
        .listAutomations(SYSTEM_SPACE_ID)
        .some((item) => item.handler === 'reflection' && item.status === 'armed' && item.enabled)
    return SpaceSettingsListSchema.parse({
      spaces: this.deps.store.spacesEngine.listAllSpaces(),
      reflection: {
        ...config.reflection,
        enabled,
        timezone: config.timezone,
        revision: settingsRevision({ ...config.reflection, enabled }),
      },
    })
  }

  read(spaceId: string): SpaceSettings {
    const { store, scheduler } = this.deps
    const space = store.getSpace(spaceId)
    if (!space) throw new Error('Space is unavailable')
    const facts = space.id === SYSTEM_SPACE_ID ? undefined : store.readFacts(space.id)
    return SpaceSettingsSchema.parse({
      space,
      facts: facts
        ? (['active', 'dormant', 'superseded'] as const).flatMap((status) =>
            facts[status].map((fact) => ({
              text: fact.text,
              ...(fact.noted ? { noted: fact.noted } : {}),
              status,
            })),
          )
        : [],
      instructions:
        space.id === SYSTEM_SPACE_ID ? null : store.spacesEngine.readInstructions(space.id),
      automations: scheduler
        .listAutomations(space.id)
        .filter(
          (automation) => automation.status !== 'cancelled' && automation.handler !== 'reflection',
        )
        .map((automation) => ({
          id: automation.id,
          kind: automation.kind,
          description: automation.description,
          enabled: automation.enabled,
          status: automation.status,
          cron: automation.cron,
          fireAt: automation.fireAt,
          nextRunAt: automation.nextRunAt,
          timezone: automation.timezone ?? 'UTC',
          managed: automation.handler !== undefined,
          revision: scheduler.automationSettingsRevision(automation),
        })),
      surfaces: space.archived
        ? []
        : store.listSurfaces(space.id).filter((surface) => surface.management !== undefined),
    })
  }

  change(spaceId: string, input: SpaceSettingsCommand): SpaceSettings {
    const command = SpaceSettingsCommandSchema.parse(input)
    const { store, scheduler } = this.deps
    const space = store.getSpace(spaceId)
    if (!space) throw new Error('Space is unavailable')
    if (command.action === 'restore') store.restoreSpace(space.id)
    else if (command.action === 'archive') store.archiveSpace(space.id)
    else {
      if (space.archived) throw new Error('Restore this Space before editing its settings')
      switch (command.action) {
        case 'presentation':
          store.spacesEngine.setSpacePresentation(space.id, command.presentation)
          break
        case 'fact':
          if (space.id === SYSTEM_SPACE_ID) throw new Error('System does not own personal facts')
          store.spacesEngine.writeFact(
            space.id,
            command.text,
            'trusted:user',
            command.supersedes === undefined ? undefined : { supersedes: command.supersedes },
          )
          break
        case 'instructions':
          store.spacesEngine.updateInstructions(space.id, command.text, command.expectedText)
          break
        case 'automation':
          scheduler.updateAutomation(space.id, command.automationId, command.change)
          break
      }
    }
    return this.read(spaceId)
  }

  changeReflection(input: z.infer<typeof ReflectionSettingsChangeSchema>): SpaceSettingsList {
    const change = ReflectionSettingsChangeSchema.parse(input)
    const { memoryConfig, reflection, store } = this.deps
    if (change.expectedRevision !== this.list().reflection.revision)
      throw new Error('Reflection settings changed. Reload before saving again.')
    const updated = { ...memoryConfig, reflection: { enabled: change.enabled, time: change.time } }
    writeJsonAtomicDurable(join(store.spacesEngine.rootDir, 'memory.json'), updated)
    Object.assign(memoryConfig.reflection, updated.reflection)
    reflection.reconcileJobs()
    for (const job of this.deps.scheduler.listAutomations(SYSTEM_SPACE_ID)) {
      if (job.handler === 'reflection' && job.status === 'armed')
        this.deps.scheduler.setEnabled(SYSTEM_SPACE_ID, job.id, change.enabled, 'surface')
    }
    store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
      type: 'reflection.settings',
      text: `Nightly Reflection ${change.enabled ? 'enabled' : 'disabled'} at ${change.time} ${memoryConfig.timezone}`,
      origin: 'trusted:user',
    })
    return this.list()
  }
}
