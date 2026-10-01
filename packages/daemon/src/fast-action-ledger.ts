import type { DatabaseSync } from 'node:sqlite'
import {
  FastActionOutcomeSchema,
  type CommittedFastActionOutcome,
  type FastActionOutcome,
} from '@veduta/protocol'
import { requiredString } from './sqlite-rows.ts'

/** Actual post-delivery projections are present before startup commit reconciliation. */
const DOMAIN_CONSUMERS = [
  'notification-settings',
  'scheduler',
  'approvals',
  'tree-proposals',
  'updates',
  'allowlist',
  'workers',
]
export class FastActionLedger {
  private readonly observers = new Map<
    string,
    (outcome: CommittedFastActionOutcome) => void | Promise<void>
  >()
  private readonly running = new Set<string>()
  private closed = false
  constructor(private readonly db: DatabaseSync) {
    for (const name of DOMAIN_CONSUMERS) this.register(name)
  }
  private register(name: string): void {
    this.db.prepare('insert or ignore into fast_action_consumers (name) values (?)').run(name)
  }
  get(intentId: string): FastActionOutcome | undefined {
    const row = this.db
      .prepare('select outcome_json from fast_action_intents where intent_id = ?')
      .get(intentId)
    return row
      ? FastActionOutcomeSchema.parse(JSON.parse(requiredString(row, 'outcome_json')))
      : undefined
  }
  isDelivered(commitId: string): boolean {
    return (
      this.db
        .prepare("select id from surface_commits where id = ? and state = 'delivered'")
        .get(commitId) !== undefined
    )
  }
  record(outcome: FastActionOutcome): void {
    this.db
      .prepare(
        'insert into fast_action_intents (intent_id, outcome_json, commit_id, event_cursor) values (?, ?, ?, ?)',
      )
      .run(
        outcome.intentId,
        JSON.stringify(outcome),
        outcome.outcome === 'committed' ? outcome.surfaceCommitId : null,
        outcome.outcome === 'committed' ? outcome.eventCursor : null,
      )
    if (outcome.outcome === 'committed')
      this.db
        .prepare(
          'insert into fast_action_receipts (intent_id, consumer) select ?, name from fast_action_consumers',
        )
        .run(outcome.intentId)
  }
  observe(
    name: string,
    observer: (outcome: CommittedFastActionOutcome) => void | Promise<void>,
  ): () => void {
    if (!name.trim() || this.observers.has(name))
      throw new Error('fast Action projection requires a unique stable consumer name')
    this.register(name)
    this.observers.set(name, observer)
    this.drain(name)
    return () => {
      this.observers.delete(name)
    }
  }
  publish(): void {
    for (const name of this.observers.keys()) this.drain(name)
  }
  private drain(name: string): void {
    if (this.closed || this.running.has(name)) return
    const observer = this.observers.get(name)
    if (!observer) return
    this.running.add(name)
    const failed = (error: unknown): void => {
      console.error('fast Action projection failed', name, error)
      this.running.delete(name)
      if (this.observers.get(name) !== observer) this.drain(name)
    }
    const received = (intentId: string): void => {
      if (!this.closed)
        this.db
          .prepare(
            'update fast_action_receipts set received = 1 where intent_id = ? and consumer = ?',
          )
          .run(intentId, name)
    }
    try {
      while (!this.closed && this.observers.get(name) === observer) {
        const row = this.db
          .prepare(
            `select i.outcome_json from fast_action_receipts r join fast_action_intents i on i.intent_id = r.intent_id join surface_commits c on c.id = i.commit_id where r.consumer = ? and r.received = 0 and c.state = 'delivered' order by i.event_cursor limit 1`,
          )
          .get(name)
        if (!row) break
        const outcome = FastActionOutcomeSchema.parse(
          JSON.parse(requiredString(row, 'outcome_json')),
        )
        if (outcome.outcome !== 'committed')
          throw new Error('projection receipt does not identify a committed Action')
        const result = observer(outcome)
        if (result instanceof Promise) {
          void result
            .then(() => {
              received(outcome.intentId)
              this.running.delete(name)
              this.drain(name)
            })
            .catch(failed)
          return
        }
        received(outcome.intentId)
      }
      this.running.delete(name)
      if (this.observers.get(name) !== observer) this.drain(name)
    } catch (error) {
      failed(error)
    }
  }
  close(): void {
    this.closed = true
    this.observers.clear()
  }
}
