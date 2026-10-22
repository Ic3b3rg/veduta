import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ensureSqliteColumn } from '../sqlite-rows.ts'
import { PUSH_ANNOUNCEMENT_SCHEMA } from '../push-announcement-schema.ts'

/** Preserve queued delivery while adding durable announcement identities (ADR-0013). */
export function migrateV4PushAnnouncements(rootDir: string): void {
  const path = join(rootDir, 'push.sqlite')
  if (!existsSync(path)) return
  const db = new DatabaseSync(path)
  try {
    for (const table of ['push_outbox', 'push_deferred']) {
      const exists = db
        .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
        .get(table)
      if (exists) ensureSqliteColumn(db, table, 'announcement_id', 'text')
    }
    db.exec(PUSH_ANNOUNCEMENT_SCHEMA)
  } finally {
    db.close()
  }
}
