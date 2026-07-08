/**
 * Typed accessors for `node:sqlite` rows, shared by the SQLite-backed
 * engines (Surfaces, scheduler): the driver returns loosely-typed
 * records and numbers may come back as bigint.
 */
export function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key]
  if (typeof value !== 'string') throw new Error(`expected string column ${key}`)
  return value
}

export function requiredNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error(`expected number column ${key}`)
}

export function optionalString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key]
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`expected string column ${key}`)
  return value
}

/** Run `write` inside one immediate transaction: all statements land or none do. */
export function withImmediateTransaction<T>(db: { exec(sql: string): void }, write: () => T): T {
  db.exec('begin immediate')
  try {
    const result = write()
    db.exec('commit')
    return result
  } catch (error) {
    db.exec('rollback')
    throw error
  }
}
