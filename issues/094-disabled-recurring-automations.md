# 094 — Stop disabled recurring Automations from recording every skipped occurrence

## Context

Turning off a recurring Automation leaves it armed with a due `next_run_at`. The Scheduler still
claims every cron occurrence, appends an `automation.skip` Event, records an Automation run with
`skipped:disabled`, advances to the next occurrence, and refreshes the Automations Surface.

For a one-minute Automation this produces up to 1,440 meaningless run records and Space events per
day after the user switched it off. Those events can displace useful recent context. The visible
toggle already records the state transition once, so per-occurrence disabled records add no user
value.

## Goal

Disabled recurring Automations remain visible and resumable but are not considered due work. They
create no claims, run outcomes, skip events, Surface refreshes, or tight scheduler wake-up loops
while disabled. Re-enabling schedules the next future cron occurrence without replaying ticks
missed while off.

## What to build

- Exclude disabled recurring Automations from Scheduler due selection and next-wake calculation.
- When an enabled recurring Automation is switched off, preserve its cron expression, timezone,
  origin, and visible off state while emitting only the existing toggle Event.
- When a disabled recurring Automation is re-enabled, compute its first valid cron occurrence
  strictly after the enable time. Do not claim, replay, or record occurrences missed while off.
- Keep ordinary claim, recovery, catch-up, and next-occurrence behavior unchanged once the
  Automation is enabled.
- Keep the accepted single due-time outcome for a disabled one-shot timer unchanged; it cannot
  produce recurring noise and is outside this bug.

## Acceptance criteria

- [ ] Advancing across many cron occurrences while a recurring Automation is disabled creates no
      claim/run rows, no `automation.skip` Events, no escalation, and no per-occurrence Surface
      update; only the original toggle Event records the pause.
- [ ] The disabled Automation remains visible on its Automations Surface with `enabled: false` and
      retains its cron expression and origin.
- [ ] Re-enabling computes the first valid occurrence strictly after the current time, fires it
      once, and never replays or records the occurrences missed while disabled.
- [ ] Scheduler sleep selection ignores disabled recurring Automations and does not repeatedly
      wake on a stale past due time when no enabled work exists.
- [ ] Restarting while a recurring Automation is disabled preserves the same paused behavior;
      restarting after re-enable preserves ordinary claim and at-least-once recovery semantics.
- [ ] Existing enabled-Automation recurrence, catch-up, timezone/DST, cancellation, origin
      propagation, Automations Surface, and one-shot timer tests remain green.
- [ ] `pnpm check` passes.

## Out of scope

- Changing the accepted behavior of a disabled one-shot timer that reaches its sole due time.
- Changing delivery policy for enabled Automation outcomes.
- External monitoring or Worker execution.
- Removing audit events for Automations that actually execute or fail.

## Blocked by

None — can start immediately.
