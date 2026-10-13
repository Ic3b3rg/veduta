import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSqliteColumn } from '../sqlite-rows.ts'

/** Add the explicit operation without guessing intent from legacy descriptions. */
export function migrateV3RecurringNotifications(rootDir: string): void {
  const path = join(rootDir, 'scheduler.sqlite')
  if (!existsSync(path)) return
  const db = new DatabaseSync(path)
  try {
    const table = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'automations'")
      .get()
    if (table) ensureSqliteColumn(db, 'automations', 'notification_json', 'text')
  } finally {
    db.close()
  }
}
