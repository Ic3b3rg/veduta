import type { Scheduler } from './scheduler.ts'

/**
 * A family of daemon-owned recurring jobs (issue #16's Heartbeat, issue #21's
 * nightly Reflection) that a boot-time reconcile must keep in sync with
 * configuration: cancel what is no longer wanted, collapse duplicates so two
 * jobs never fire the same instant, create what is missing, and never touch
 * a survivor's `enabled` flag. This module knows nothing about what any
 * handler does — same idiom as `Scheduler.registerHandler` — it only ever
 * sees crons, descriptions and ids.
 */
export interface ManagedJobSpec {
  scheduler: Scheduler
  spaceId: string
  /** `Automation.handler` value identifying this family of daemon-owned jobs. */
  handler: string
  enabled: boolean
  /** Wanted jobs: cron expression -> human description. */
  desired: Map<string, string>
  /** Optional IANA zone the cron fields are interpreted in; absent means UTC. */
  timezone?: string
}

/** `(cron, timezone)` pair identity, joined so it can key a `Map`/`Set`. */
function jobKey(cron: string, timezone: string | undefined): string {
  return `${cron}::${timezone ?? ''}`
}

/**
 * Reconciles one Space's daemon-owned jobs for one `handler` family to
 * exactly `desired`. Extracted from the Heartbeat's original reconcile
 * (issue #16) so issue #21's Reflection job can reuse the same convergence
 * logic rather than a second copy of it.
 *
 * The survivor key is `(cron, timezone)`, not the cron alone: a cron
 * expression's five fields don't say which zone they are read in, so
 * changing the configured zone while keeping the same time-of-day produces
 * an identical cron string. A cron-only key would then see that string as
 * still wanted and leave the old job in place — e.g. a Reflection job would
 * keep firing at the previous zone's 04:00 forever. Keying on the pair means
 * a zone change cancels the old job and creates a new one carrying the new
 * zone, exactly like a cron change would. Jobs with no `timezone` (the
 * Heartbeat's, always UTC) key on `(cron, '')`, so their behaviour is
 * unchanged by this generalization.
 */
export function reconcileManagedJobs(spec: ManagedJobSpec): void {
  const { scheduler, spaceId, handler, enabled, desired, timezone } = spec

  const jobs = scheduler
    .listAutomations(spaceId)
    .filter((automation) => automation.handler === handler)

  if (!enabled) {
    // Disabled: no armed job of this family survives, so the scheduler can
    // never fire it.
    for (const job of jobs) {
      if (job.status !== 'cancelled') scheduler.cancel(job.id, 'trusted:system')
    }
    return
  }

  const armedJobs = jobs.filter((job) => job.status !== 'cancelled')
  const desiredKeys = new Set([...desired.keys()].map((cron) => jobKey(cron, timezone)))

  // Cancel every armed job whose (cron, timezone) key is no longer desired.
  for (const job of armedJobs) {
    if (job.cron === undefined || !desiredKeys.has(jobKey(job.cron, job.timezone))) {
      scheduler.cancel(job.id, 'trusted:system')
    }
  }

  // Among jobs on a still-desired key, keep exactly one (the first, i.e.
  // lowest id) survivor and cancel any extras — two live jobs of this
  // family firing the same instant must never coexist.
  const survivorKeys = new Set<string>()
  for (const job of armedJobs) {
    if (job.cron === undefined) continue
    const key = jobKey(job.cron, job.timezone)
    if (!desiredKeys.has(key)) continue
    if (survivorKeys.has(key)) {
      scheduler.cancel(job.id, 'trusted:system')
    } else {
      survivorKeys.add(key)
    }
  }

  for (const [cron, description] of desired) {
    if (survivorKeys.has(jobKey(cron, timezone))) continue
    scheduler.createManagedJob(
      {
        spaceId,
        cron,
        description,
        handler,
        ...(timezone === undefined ? {} : { timezone }),
      },
      'trusted:system',
    )
  }
}
