# Fixture corpus: every format ever written to an append-only file

This directory is the frozen record backing `fixture-corpus.test.ts`
(issues/043-self-update.md AC5). `docs/adr/0013-signed-self-update.md`'s
two-data-regimes rationale requires tolerant readers of append-only
stores — the surface-event log and the Space Event log — to keep parsing
every shape they have ever produced, forever. This corpus is how that
promise stays checked instead of assumed: each file is a real (or
reconstructed) raw record from one of those stores, and the test asserts
every one of them still parses.

## Contract

- **Frozen, not edited.** Once a file lands here it is never changed. A
  fixture represents a shape that was actually persisted at some point;
  changing it after the fact would let a regression hide behind an edit
  instead of a new format.
- **Additions only.** A new historical shape (a schema change, a bug that
  wrote a different shape than intended, a defensive-migration boundary)
  gets a new file, never a replacement of an old one.
- **Every entry must keep parsing.** `fixture-corpus.test.ts` fails the
  build the moment any file here stops parsing through its store's normal
  read path. That is the whole point: the corpus is what makes "stop
  supporting an old format" a change someone has to notice and justify,
  not something that happens by accident.

## Contents

- `surface-event-*-pre-freshness.json` — `surface_events` rows for kinds
  `patch` and `pinned` written before `freshness` was stamped on every
  write (the 2026-08-04 incident behind this issue: a strict schema parse
  of one of these rows on the Gateway's hello replay killed the boot with
  the data otherwise intact). Read via the row-reader tolerance in
  `surface-engine.ts`, never via a loosened protocol schema.
- `surface-event-*-current.json` — the shape current before Gateway-owned
  Surface ordering. It remains frozen and readable through the lifecycle
  order fallback.
- `surface-event-*-order-v1.json` — the Gateway-owned ordering shape for
  lifecycle events (`created`, `pinned`, `moved`, `archived`), including the
  complete authoritative order carried over the wire.
- `space-event-log.jsonl` — three lines for the Space Event log: a
  current-shaped `SpaceEvent`, a minimal legacy-shaped one (missing the
  optional `occurredAt`/`payload` fields), and one line of garbage. The
  Event log is append-only and never rewritten (ADR-0003/ADR-0006), so its
  reader (`parseSpaceEventLine`) already drops an unparseable line instead
  of throwing — this fixture is what keeps that behavior honest.

Each `surface-event-*.json` file is one `surface_events` row: `cursor`,
`at`, `spaceId`, `surfaceId`, `kind` are the row's own columns; `event` is
the exact `event_json` payload that row stored, unmodified.
