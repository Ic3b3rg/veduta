# 130 — Enforce rendered FACTS high and hard watermarks

## Parent

#32

Repository specification:
[issues/130-facts-high-hard-watermarks.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/130-facts-high-hard-watermarks.md)

## What to build

Complete the FACTS budget that #21 began. Extend `<rootDir>/memory.json` with tunable `budget.high`
and `budget.hard` values alongside `low`, defaulting to 6,000 and 8,000 UTF-16 code units (`low`
remains 4,000). Validate the ordering `low < high < hard` and measure the shared rendered active
projection, including dates, origin labels, and wrappers, in O(projection length) without
tokenization.

Crossing `high` marks that Space's Reflection pending. It does not start an immediate model call,
drop active facts, or block writes; the next scheduled Reflection compacts toward `low`. A candidate
that would move a projection from at-or-below `hard` to above it is rejected by `write_fact` with an
explicit tool error. While a file is already above `hard`, Noop and writes whose post-Curator
rendered active projection is strictly smaller remain allowed; same-size or growing mutations are
rejected. Reaching exactly `hard` is allowed.

Audit FACTS at boot/restore. An existing over-hard Space remains usable, is marked for the next
scheduled Reflection, and exposes durable health state for the dependent System Surface. Reconcile
and remove the interim `MAX_WRITTEN_FACT_CHARS = 1000` limit so the rendered hard watermark is the
single write budget.

## Acceptance criteria

- [ ] Memory configuration supports validated low/high/hard defaults of 4,000/6,000/8,000 UTF-16
      code units.
- [ ] Budget decisions use the shared rendered active projection and remain O(projection length).
- [ ] Crossing `high` persistently marks Reflection pending without an immediate model call,
      truncation, or write rejection.
- [ ] `write_fact` accepts a projection at exactly `hard`, rejects hard+1 explicitly, and never
      persists the rejected candidate.
- [ ] An already-over-hard Space accepts Noop and strictly size-reducing writes but rejects same-size
      and growing writes.
- [ ] Boot/restore audits pre-existing files, preserves their contents, keeps the Space functional,
      and schedules compaction toward `low`.
- [ ] The interim per-fact character cap is removed rather than becoming a second hidden limit.
- [ ] Boundary, restart, and performance tests cover the resolved cases, and `pnpm check` passes.

## Blocked by

- #34
- #129
