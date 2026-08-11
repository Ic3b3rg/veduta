import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { ensureSqliteColumn, requiredString } from './sqlite-rows.ts'

describe('ensureSqliteColumn', () => {
  it('adds a missing column and is idempotent', () => {
    const db = new DatabaseSync(':memory:')
    try {
      db.exec('create table records (id integer primary key)')
      ensureSqliteColumn(db, 'records', 'label', 'text')
      ensureSqliteColumn(db, 'records', 'label', 'text')

      const names = db
        .prepare('pragma table_info(records)')
        .all()
        .map((row) => requiredString(row, 'name'))
      expect(names).toEqual(['id', 'label'])
    } finally {
      db.close()
    }
  })
})
