# 016 — Safety-net Heartbeat + escalation cascade

## Context
[ADR-0005](../docs/adr/0005-event-driven-proactivity.md): the Heartbeat is the safety net (1-2x/day), not the engine.

## Goal
The periodic sweep for fuzzy conditions that cannot be expressed as events or timers.

## Tasks
- Configurable recurring job (default 2x/day, can be switched off) that runs in a fresh session: per-Space checklist ("time-sensitive Surfaces without a timer? anomalous patterns in the log? anything I should have turned into a timer and didn't?")
- Cascade: first pass on the `triage` tier with structured output (nothing | list of concerns); only with concerns → `reasoning` tier to decide the actions
- Self-improvement: if the Heartbeat finds something that *could* have been a timer, the preferred action is to arm the timer (so the next sweep isn't needed)
- Metrics: % of "nothing to do" sweeps (target > 80%: if lower, timers/events are missing), cost per sweep

## Acceptance criteria
- With all Spaces in order, the sweep stops at triage: a single cheap call (assert)
- A "today's plan" Surface stuck at yesterday (no timer armed due to a bug) is found and refreshed on the next sweep
- `heartbeat.enabled: false` truly turns it off (zero calls)

## Dependencies
010, 011
