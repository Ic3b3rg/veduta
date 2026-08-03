# 038 — Agent loop wiring II: live completions for the proactive subsystems

## Context

Part II of the Agent loop wiring (part I: [issue 037](037-agent-loop-chat.md), which lands
the provider bridge and the completion helper this issue consumes). Four proactive
subsystems run on deterministic stand-in completions, but they are **not** equally wired:

- **Heartbeat** (`server.ts`): `complete: () => '{"status":"nothing"}'` — the issue-016
  triage→reasoning cascade never actually reasons. Already routes through
  `ModelRouter.execute` with purposes `heartbeat` / `heartbeat-reasoning` and records spend;
  only the callback swaps.
- **Quarantined reader** (`mock-provider.ts` `mockReaderComplete`): the SECURITY.md §3.1
  tool-less completion that turns accepted external events into schema-validated,
  taint-marked structured fields. Already routed (`quarantined-reader`) with spend recorded;
  only the callback swaps.
- **Scheduler judge** (`server.ts`): a deterministic `"unknown"` (fail-safe: escalate),
  handed to the Scheduler as a **direct callback** — no router, no spend, no cap check. The
  in-place comment names its destination,
  `router.execute({ purpose: 'classification', origin: 'proactive' })`: that routing, spend
  recording, and cap handling are part of this issue, not pre-existing.
- **Reflection distiller** (`mock-reflection-distiller.ts`): the nightly issue-021
  "sleep-time compute" completion. `Reflection`'s options carry neither a `ModelRouter` nor
  spend wiring, and no `CallPurpose` exists for it — add one rather than overloading
  `mechanical-update`, and wire routing/spend/caps alongside the live completion.

## Goal

Heartbeat, scheduler judgments, quarantined reading, and nightly Reflection make real model
calls on profiles with keys — under the same per-tier caps and audit trail they already use —
while keyless profiles keep today's deterministic behavior via the mock candidate.

## Tasks

- Replace the four injected completions with live calls through the 037 provider bridge
  (completion-style, no agent session, no tools).
- Route the two unrouted subsystems: the scheduler judge through
  `router.execute({ purpose: 'classification', origin: 'proactive' })` and Reflection
  through a new `CallPurpose` with its tier mapping in `tierForRequest` — both gaining
  spend recording, cap enforcement, and call-log entries for the first time.
- Harden each consumer against real-model output: every completion result is
  schema-validated at the boundary and degrades to the subsystem's existing fail-safe on
  invalid output (judge → `unknown`, Heartbeat → escalate-nothing, reader → reject the
  handoff). Reflection on invalid output records a **visible failed outcome without writing
  a terminal marker**, so the next run re-reads the same window — never a skip marker that
  would advance the boundary and permanently omit the window from distillation
  (`reflection.ts` recovery contract).
- Keep keyless profiles deterministic: with no resolvable key the mock candidate serves the
  same fixture behavior the current stand-ins provide (`pnpm dev` and the e2e suite are
  unchanged).

## Acceptance criteria

- Fake-provider integration tests per subsystem: the Heartbeat cascade stops at triage on a
  "nothing" verdict and escalates through reasoning on concerns; the judge returns only
  `yes | no | unknown` and falls back to `unknown` on schema-invalid output; the reader
  stays tool-less and emits only schema-validated structured fields (raw text never reaches
  Agent context); Reflection preserves its report schema, evidence references, fact origins,
  and terminal markers.
- A tier's exhausted daily cap stops further proactive calls on that tier (per-tier
  `proactivityAllowed` semantics) with the existing cap notice in chat; calls on the other
  tier are unaffected.
- Spend: Heartbeat and reader keep their existing `recordSpend` paths untouched; judge and
  Reflection calls now appear in `usage/` and the call log for the first time, attributed
  to the right tier.
- Reflection invalid-output run: failed outcome visible as an Automation note, no terminal
  marker written, and the following run distills the same window successfully.
- With zero keys, `pnpm dev` behavior and the full e2e suite are unchanged.

## Dependencies

011, 012, 013, 016, 021, 037
