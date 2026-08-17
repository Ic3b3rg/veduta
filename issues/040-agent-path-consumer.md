# 040 — Agent-path Surface actions: a durable consumer for the queued turns

## Context

Since issue 007, Surface actions declared `agentPath` are persisted by
`SurfaceEngine.enqueueAgentAction` (`surface-engine.ts`) as `QueuedAgentTurn`s with an
honest `agent_path` Event log entry — but nothing consumes the queue. The click is
acknowledged, recorded, and then waits forever; the only consumer-shaped code is the
full-text request path, which serves exactly one hardcoded flow. With the interactive Agent
loop landed ([issue 037](037-agent-loop-chat.md)), the queue finally has something to feed.

## Goal

A queued Agent-path action becomes a real agent turn in its Space — durably: claimed once,
executed with the queue entry's recorded provenance, recovered after a crash, and visible in
the UI from click to outcome.

## Tasks

- **Queue schema**: today's `QueuedAgentTurn` and its SQLite row store neither origins nor
  a lifecycle status, and the enqueue Event does not carry the queue id — the provenance
  and the click → queue → turn → outcome chain this issue asserts cannot be recovered from
  what is persisted. Migrate the table (origins captured at enqueue time, status column,
  stable queue id) with a backfill for pre-existing rows, and put the queue id in the
  `agent_path` Event entry so the chain has correlation fields end to end.
- **Consumer**: feed queued turns into the Space's serialized session via the 037 loop —
  trigger `{ kind: 'agent-turn' }` carrying the queued invocation's provenance, origins
  taken from the queue entry, routed as a user-origin `chat-turn` (the click is a user
  act).
- **Durability**: claim semantics that survive concurrent consumers and crashes — a turn is
  executed at most once; unclaimed and half-executed entries are recovered at boot
  (`recoverAtBoot` mirror of the WorkerPool pattern); terminal states recorded back on the
  queue entry and in the Event log.
- **UI status**: the Surface shows the action's in-flight / done / failed state (existing
  patch flow; no new Atom types), so a click never silently disappears.
- **Backpressure**: a bounded queue per Space; when full, the enqueue is refused with a
  defined Gateway error frame and the refusal is visible on the Surface — capacity,
  refusal shape, and its acceptance test are specified here, since the protocol has only a
  generic error frame today.

## Acceptance criteria

- Clicking an `agentPath` action produces (fake provider) an agent turn in that Space whose
  Event log chain links click → queued entry → turn → outcome; the Surface reflects
  in-flight and terminal states.
- Kill the daemon between enqueue and execution: on restart the turn runs exactly once;
  kill it mid-turn: the entry lands in a terminal failed state with a visible retry
  affordance, never a duplicate execution.
- Origins recorded at enqueue time (post-migration) govern the turn's tool gating (an
  untrusted-content Space context cannot launder through the queue); backfilled legacy rows
  degrade to the conservative default rather than trusted.
- A full per-Space queue refuses the enqueue with the defined error frame, visibly on the
  Surface, and the refusal is covered by a test.
- With zero keys the mock candidate answers the queued turn deterministically; e2e suite
  covers the happy path.

## Blocked by

None — builds on completed issues #7 and #37.
