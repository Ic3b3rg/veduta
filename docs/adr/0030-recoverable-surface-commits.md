# Surface commits recover across SQLite and the Space Event log

A validated Surface mutation and its matching Space Event form one domain outcome even though they
live in two durable stores. Veduta cannot make SQLite and an append-only JSONL file participate in
one physical transaction, so it must not report success after only one side commits or report a
generic failure after both sides have committed.

Every Event-requiring Surface mutation therefore receives a stable **Surface commit** identity. In
the same SQLite transaction as the Surface mutation, the Gateway stores a durable commit record with
the owning Space, ordered identity, and already-redacted Event payload. After that transaction
commits, a reconciler appends the Event carrying the same identity, makes the file and any newly
created directory entry durable, and only then marks the commit delivered. Success and realtime or
diagnostic observers occur only after delivery. Observer failures are isolated and can never change
the committed outcome.

An append or durability failure leaves the Surface commit in `recovery_pending`, not a final success
or generic error. The Gateway retains the intent, preserves per-Space order, and blocks Agent
reasoning for that Space until reconciliation completes; unaffected Spaces continue normally. On
live retry, startup, or restored-backup recovery, the reconciler checks the append-only Event log for
the stable identity before appending, so a crash after the Event becomes durable but before SQLite is
marked delivered cannot duplicate the Event. A commit that failed before its SQLite transaction
became durable leaves neither side.

The upgrade records an explicit baseline and provides exact guarantees only for new Surface commit
identities. Historical Surface/Event mismatches cannot be inferred safely from timestamps or
payloads and are not heuristically repaired or rewritten. The Event log remains canonical
provenance; the SQLite commit record is a recovery mechanism, not a second Event history or a
replacement for the append-only log.

Alternatives rejected were acknowledging the current SQLite-then-append sequence, writing the Event
first, moving Event truth into SQLite, compensating by deleting or rewriting append-only Events, and
guessing legacy pairs. Each either preserves a split-brain success window, creates the inverse ghost,
or violates the Event log contract.

Status: accepted
