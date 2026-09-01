# 156 — Make Surface commits recoverable across both durable stores

## Verified bugs

A Surface mutation currently commits in SQLite before its matching append-only Space Event is
written. If the Event append fails, the Surface remains changed without the provenance that the
Agent must read before reasoning. The inverse user-visible lie is also possible: after both durable
writes succeed, a realtime or diagnostic observer can throw and make the caller see a failure even
though retrying may duplicate intent.

The Event append is not itself power-loss durable before success is returned. SQLite and JSONL
cannot share one physical transaction, and historical rows have no stable cross-store identity from
which an exact repair can be inferred.

## What to build

Implement ADR-0030 with one recoverable Surface-commit protocol for every validated Surface
mutation that requires a matching Space Event. This includes Surface creation, Pin changes, moves,
archival, state and tree patches including fast-path actions, queued Agent-path actions, and Tree
proposals.

Assign each Surface commit a stable identity. Persist an ordered commit record and an already
redacted Event payload in the same SQLite transaction as the mutation. Then append the matching
Event with that identity, make the Event file and any first-use directory entry durable, and mark
the record delivered. Only a delivered Surface commit is successful and eligible for realtime,
Trace, or other post-commit observers.

A failure after SQLite commits but before durable Event delivery is `recovery_pending`. Retain and
reconcile it in order without guessing, block Agent reasoning for the affected Space until its
pending commits complete, and allow unaffected Spaces to proceed. Recovery must be idempotent after
live retry, process restart, a crash at either durability boundary, and backup restore.

## Acceptance criteria

- [ ] Every Event-requiring Surface mutation uses one Surface-commit boundary with a stable identity
      present in its durable SQLite commit record and matching Space Event.
- [ ] The Surface mutation, ordered commit identity, owning Space, correlation fields, and
      already-redacted Event payload commit in one SQLite transaction; failure before that commit
      leaves neither a mutation nor an Event.
- [ ] Event delivery appends the prepared payload, durably flushes the file, durably records a newly
      created day-log directory entry when applicable, and only then marks the Surface commit
      delivered and returns success.
- [ ] Append, permission, disk-full, file-flush, or directory-flush failure produces a durable
      `recovery_pending` outcome rather than success or an ambiguous generic failure. The caller can
      identify the affected Surface commit without resubmitting the mutation.
- [ ] Recovery drains pending Surface commits in original per-Space order. Agent reasoning cannot
      observe the affected Space as settled until reconciliation completes, while reads and other
      Spaces remain available under an explicit recovery state.
- [ ] A crash after the Event becomes durable but before the delivered marker is committed cannot
      append a duplicate: reconciliation detects the stable identity in the append-only log and
      completes the existing Surface commit.
- [ ] Reconciliation handles restart on a later calendar day using the commit's original Event
      destination, a final torn JSONL tail, repeated idempotency keys, and multiple ordered pending
      commits without rewriting prior valid Events.
- [ ] Realtime broadcasts, Trace, notifications, and other observers run only after delivery and are
      isolated: observer failure is recorded diagnostically but cannot fail, roll back, or change a
      delivered Surface commit.
- [ ] Backup and restore tests cover snapshots taken before SQLite commit, while recovery is
      pending, after Event durability but before the delivered marker, and after delivery; restored
      startup converges to one mutation and one Event.
- [ ] Upgrade records an explicit pre-Surface-commit baseline. Exact recovery applies to new commit
      identities only; startup does not heuristically pair, invent, delete, or rewrite legacy
      Surface/Event history.
- [ ] Fault-injection tests cover every durability boundary and all Event-requiring mutation
      families through public engine contracts, including same-action idempotency and per-Space
      isolation.
- [ ] The isolated fast-path benchmark keeps p95 completion within the existing 100 ms target; the
      full-suite timing guard remains at 400 ms so CI load is not mistaken for product latency.
- [ ] `pnpm check` passes.

## Out of scope

- Pretending SQLite and JSONL participate in one physical or distributed transaction.
- Moving the canonical Event log into SQLite, deleting or rewriting append-only Events, or using
  Trace as mutation provenance.
- Heuristic repair of pre-upgrade mismatches or destructive migration of existing development data.
- Agent-path queue consumption, Chat submission recovery, new Surface behavior, or unrelated store
  cleanup.

## Blocked by

None — can start immediately.
