# 011 — Scheduler: one-shot timers, jobs, visible automations

## Context
[ADR-0005](../docs/adr/0005-event-driven-proactivity.md): "events and timers first, polling as a last resort". Automations are visible and can be switched off (the "UI plus").

## Goal
The daemon's scheduling system, exposed to the Agent as tools and to the user as a Surface.

## Tasks
- Job store (SQLite): one-shot (ISO timestamp), recurring (cron), with `spaceId`, human description, enabled/disabled, last run/outcome
- Agent tools: `arm_timer(when, condition, action)`, `create_job(cron, briefing)`, `cancel`; prompt rule: every learned deadline/habit → a timer, not "I'll remember it"
- Execution: a firing timer first evaluates the condition deterministically where possible (e.g. "is event X present in the log?"), and calls the LLM (triage tier) only if the condition requires judgment
- Robustness: persistence across restarts, catch-up of timers expired during a downtime (policy: run if < 24h, otherwise report), anti-double-execution lock
- `Automation` Atom populated: every job appears in its Space, immediate toggle (fast path)

## Acceptance criteria
- "Remind me to log my weight by 9pm" → timer visible in the Space; at 9pm with no weight in the log → escalation; with the weight → no action (test with a fake clock)
- A job disabled by the user does not run and remains visible as off
- Daemon restart with 3 pending timers: none lost, none duplicated

## Dependencies
003, 006
