import { join } from 'node:path'
import { Store } from '../../daemon/src/store.ts'
import { Scheduler } from '../../daemon/src/scheduler.ts'
import { createControlSurface } from './control-surfaces.ts'

export function createDatePickerFixtures(baseDir: string): void {
  createControlSurface(baseDir)
  const rootDir = join(baseDir, 'data')
  const store = new Store({ rootDir })
  const scheduler = new Scheduler({ rootDir, store })
  try {
    scheduler.armTimer({
      spaceId: 'spc-health',
      when: '2090-07-08T09:00:00.000Z',
      action: 'Calendar reminder',
    })
  } finally {
    scheduler.stop()
    store.close()
  }
}
