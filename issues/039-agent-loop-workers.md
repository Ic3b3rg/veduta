# 039 — Agent loop wiring III: real Worker runs and the full-text turn

## Context

Part III of the Agent loop wiring (part I: [issue 037](037-agent-loop-chat.md)). Two
isolated-execution paths still run on stand-ins:

- **Workers** (issue 017): `WorkerPool` is constructed with
  `runnerFactory: () => createMockWorkerRunner()` and
  `reviewComplete: createMockWorkerReviewComplete()` (`server.ts`); `workerTools` is an
  empty L0-only registry the scripted runner never dispatches against. Worker spend
  attribution (`workerId`) and budgets are already wired.
- **Full-text flow** (SECURITY.md §3.3): the dedicated delimited untrusted turn runs on
  `new MockAgentRunner()`. The in-place comment promises "swaps the instance, nothing
  else", but the flow calls `runner.prompt()` directly (`full-text-flow.ts`) — with a real
  runner it also needs a routed model, a purpose, spend, and retry metadata, while keeping
  its serialized dedicated session and its L0-only, delimited, untrusted contract.

## Goal

`spawn_worker` dispatches real isolated investigate-and-report runs with an honest L0 tool
registry and adversarial review, and the "read me the full text" turn runs on a real model —
both under budgets, caps, and the same audit trail, with keyless profiles unchanged.

## Tasks

- **Worker runner**: `runnerFactory` returns real `PiAgentRunner`s — isolated per-worker
  sessions (never the Space session), models routed with purpose `worker` and the worker's
  `workerId` threaded into spend recording; token/iteration budgets enforced as today.
- **Worker L0 registry**: define the real read-only registry (`read_recent`, `search_log`,
  memory retrieval — L0 only, asserted by the pool constructor as today) and its Pi
  parameter schemas.
- **Worker review**: `reviewComplete` becomes a live tool-less completion through the 037
  bridge (own purpose or `worker`, decided with the tier mapping); high-risk briefings keep
  the fresh, tool-less adversarial review before delivery; reject → corrective retry flow
  preserved.
- **Full-text turn**: swap `MockAgentRunner` for a `PiAgentRunner` gated to L0, executed
  through the router with a new `CallPurpose`; keep the single serialized session, the
  untrusted origin, and the delimited-content contract exactly as SECURITY.md §3.3
  specifies.
- Keyless profiles keep the current deterministic fixtures via the mock candidate.

## Acceptance criteria

- Fake-provider integration tests: a `spawn_worker` dispatch runs an isolated session whose
  output lands as `untrusted:worker`; the worker cannot invoke anything above L0 (attempt
  → refusal, asserted); a high-risk briefing goes through a fresh tool-less review, and the
  reject → corrective-retry path still converges.
- Worker spend appears in `usage/` under the right `workerId` and — per the issue-010
  daily-cap contract — also increments the tier totals; exhausting a worker's own budget
  stops that worker only, while other work on the tier continues until the tier cap itself
  is reached.
- The full-text flow on a real (fake-provider) turn: content arrives delimited and marked
  untrusted, only L0 tools are reachable, one turn in flight at a time, and the reply
  reaches only the requesting client.
- With zero keys, `pnpm dev` and the e2e suite are unchanged.

## Blocked by

None — builds on completed issues #13, #17, #21, and #37.
