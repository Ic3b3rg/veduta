import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { Scheduler } from '../../daemon/src/scheduler.ts'
import { SurfaceSchema, SYSTEM_SPACE_ID } from '../../protocol/src/index.ts'

export const HEALTH_RECORDED_AT = '2026-10-09T04:08:08.751Z'
export const TEMPORAL_SURFACE_TITLE = 'Saved Health dates'

/** Saved data predating presentation hints, plus canonical schedules on disposable local data. */
export function createTemporalPresentationFixtures(baseDir: string): void {
  const rootDir = join(baseDir, 'data')
  const now = () => new Date('2030-07-08T13:00:00.000Z')
  const store = new Store({ rootDir, now })
  const scheduler = new Scheduler({ rootDir, store, now })
  try {
    store.createSurface(
      SurfaceSchema.parse({
        id: 'srf-saved-health-dates',
        spaceId: 'spc-health',
        title: TEMPORAL_SURFACE_TITLE,
        freshness: { updatedAt: HEALTH_RECORDED_AT, updatedBy: 'agent' },
        state: {
          measurements: [{ recordedAt: HEALTH_RECORDED_AT, weight: 72 }],
          rows: [
            { recordedAt: HEALTH_RECORDED_AT, date: '2026-10-09', weight: 72 },
            { recordedAt: '2026-02-30', date: '10/09/2026', weight: 0 },
          ],
        },
        tree: {
          id: 'saved-health',
          type: 'Col',
          children: [
            {
              id: 'weight-chart',
              type: 'Chart',
              binding: 'measurements',
              props: {
                type: 'line',
                xKey: 'recordedAt',
                yKey: 'weight',
                label: 'Recorded weight',
                xLabel: 'Recorded',
                yLabel: 'Weight (kg)',
                emptyText: 'No measurements',
              },
            },
            {
              id: 'weight-history',
              type: 'Table',
              binding: 'rows',
              props: {
                columns: ['recordedAt', 'date', 'weight'],
                caption: 'Measurement dates',
              },
            },
            {
              id: 'legacy-rule',
              type: 'Automation',
              props: {
                label: 'Saved recurring label',
                enabled: false,
                schedule: 'cron 0 4 * * * (Europe/Rome) — next 2030-07-09 02:00 UTC',
              },
            },
            {
              id: 'legacy-timer',
              type: 'Automation',
              props: {
                label: 'Saved reminder',
                enabled: false,
                schedule: 'once at 2030-07-09 21:00 UTC',
              },
            },
            {
              id: 'complex-rule',
              type: 'Automation',
              props: {
                label: 'Complex recurrence',
                enabled: false,
                schedule: 'Configured schedule',
                scheduleDetails: {
                  kind: 'job',
                  cron: '*/20 9-11 1,15 1,6 1-5/2',
                  timezone: 'Europe/Rome',
                },
              },
            },
          ],
        },
      }),
      'agent',
    )
    scheduler.createManagedJob({
      spaceId: SYSTEM_SPACE_ID,
      cron: '0 4 * * *',
      timezone: 'Europe/Rome',
      description: 'System date presentation check',
      handler: 'date-presentation-fixture',
    })
    scheduler.createJob({
      spaceId: 'spc-health',
      cron: '15 8 * * 1-5',
      briefing: 'Health date presentation check',
    })
  } finally {
    scheduler.stop()
    store.close()
  }
}
