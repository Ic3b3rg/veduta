# 108 — Make every Surface-order mutation Gateway-owned and replayable

## Parent

- #106

## What to build

Replace browser-owned Surface arrangement with one durable Gateway-owned order for every Space.
Every active Surface belongs exactly once to its pinned or regular group, and Home applies only
authoritative snapshot, mutation, live, or replay results. Creation, archival, Pin, Unpin, and
one-step Move all update that shared order while preserving the existing Template, tree-protection,
trust, and human-only Unpin guarantees.

The authority cutover includes deterministic upgrade backfill and retirement of obsolete
browser-local order. It is intentionally one slice: separating the write authority from the client
cutover would leave two competing sources of truth.

## Acceptance criteria

- [ ] Every Space has independent pinned and regular orders, with each active Surface represented exactly once in the group selected by its validated pinned state.
- [ ] Gateway snapshots expose Surfaces in canonical pinned-first order, and a fresh browser renders that order without deriving or repairing a preference.
- [ ] A new Surface enters first in the regular group, while archiving removes it from active order without leaving a placeholder.
- [ ] An effective Pin inserts the Surface first in Pinned; an effective Unpin inserts it first in regular; neither transition imposes a numeric Pin limit.
- [ ] A relative one-step Move is authenticated, resolves against the Gateway's latest persisted order, and can move only an active Surface within its current Space and group.
- [ ] Unknown, archived, cross-Space, out-of-boundary, and otherwise invalid Move targets are rejected without changing order or appending an Event.
- [ ] Concurrent relative Moves are serialized in one write boundary and produce one canonical order rather than a stale whole-list overwrite or user-visible conflict workflow.
- [ ] Repeating Pin on an already pinned Surface or Unpin on a regular Surface returns the current authoritative result without changing order, freshness, cursor, Template count, storage, Event-log length, or broadcasts.
- [ ] Every effective Pin, Unpin, and Move appends an accurately attributed entry to the owning Space's Event log; realtime ordering events remain distinct from that durable log.
- [ ] Effective Pin continues to save the composition as a Template and preserve tree locking, state updates, Tree proposals, daemon-owned exclusions, and Agent-can-pin-but-cannot-Unpin authorization.
- [ ] Mutation responses plus cursor-ordered live and replay events carry sufficient authoritative result data for duplicate application and HTTP/WebSocket delivery races to converge harmlessly.
- [ ] Existing installations with no authoritative order backfill once from durable Surface events: latest accepted Pin orders Pinned newest first; latest creation or Unpin orders regular newest first; incomplete history and ties use stable Surface-id fallback; archived Surfaces are excluded.
- [ ] Backfill is restart-safe and idempotent, and established manual order is never overwritten by later Event-history reconstruction.
- [ ] Once a canonical snapshot arrives, obsolete browser-local Surface-order data is ignored and removed; cached Home may retain only the last canonical snapshot for offline reading.
- [ ] Protocol and Gateway integration tests cover snapshots, mutation responses, validation, lifecycle placement, strict idempotency, serialization, replay, Event entries, migration cases, and restart persistence through public contracts.
- [ ] pnpm check passes.

## Blocked by

- None — can start immediately.
