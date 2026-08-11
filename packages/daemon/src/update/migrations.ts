import { stampDataVersion } from './data-version-marker.ts'

/**
 * One forward-only data migration (`docs/adr/0013-signed-self-update.md`):
 * sqlite/derived stores only. Append-only truth files (the Event log,
 * FACTS, USER/SOUL) are never rewritten (ADR-0003/ADR-0006), and the hybrid
 * memory index rebuilds on mismatch rather than migrating (ADR-0011) —
 * neither belongs here. `migrate` must be idempotent:
 * `runMigrations` re-stamps `data-version.json` to this step's `to` right
 * after it runs, so a crash mid-transaction resumes on the next boot by
 * re-running from the last *completed* step, which means any given step can
 * be asked to run again against a root it already finished.
 */
export interface DataMigration {
  readonly to: number
  readonly description: string
  migrate(rootDir: string): void
}

/**
 * Ordered ascending, each `to` exactly one more than the previous one —
 * `migrations.test.ts` asserts that contiguity so a gap can never be
 * introduced by mistake. Migration 1 has no schema work of its own: issue
 * #43 is what introduces `data-version.json` at all, so its entire effect
 * is the marker stamp `runMigrations` already performs after every step
 * (see `data-version.ts`'s `ensureDataVersion` for the one-time bootstrap
 * that runs this against a pre-issue-43 data root).
 */
export const MIGRATIONS: readonly DataMigration[] = [
  {
    to: 1,
    description:
      'Adopt the data-version marker. No schema change: disposable derived ' +
      'stores already rebuild on mismatch (ADR-0011) and truth files are ' +
      'never rewritten (ADR-0003/ADR-0006) — this step only establishes the ' +
      'marker that ensureDataVersion checks on every future boot.',
    migrate: () => {},
  },
]

/**
 * Runs every migration whose `to` falls in `(span.from, span.to]`, in
 * ascending order, stamping `data-version.json` to that step's `to`
 * immediately after it completes. That per-step stamp is what makes a crash
 * between two steps safe to resume: the marker is left at the last step
 * that actually finished, so re-running the same span only redoes the steps
 * that never got their stamp, not the ones already done. Returns the `to`
 * values actually run, in order.
 */
export function runMigrations(rootDir: string, span: { from: number; to: number }): number[] {
  const ran: number[] = []
  for (const migration of MIGRATIONS) {
    if (migration.to <= span.from || migration.to > span.to) continue
    migration.migrate(rootDir)
    stampDataVersion(rootDir, migration.to)
    ran.push(migration.to)
  }
  return ran
}
