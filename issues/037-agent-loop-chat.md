# 037 — Agent loop wiring I: provider bridge + the interactive chat turn

## Context

Every piece the interactive Agent loop needs has shipped: `PiAgentRunner` wrapping
`pi-agent-core` (ADR-0004) with origin/taint threading, per-turn tool gating, session
branching, and a `PiJsonlSessionStore`; the `ModelRouter` with BYOK secrets, failover,
per-tier daily caps, and call logging (`router.execute(request, fn)` owns tier selection,
candidate failover, cap enforcement — callers only supply `fn`); the trust layer and
trust-wrapped outbound tools; Surface, memory, Template, and scheduler tools, all built and
tested. What never landed is the thread through them: **no code path calls a real model**.

The chat-side stand-ins this issue replaces (all annotated in place as placeholders the real
loop replaces outright):

- `gateway.ts handleChannelMessage` answers via `handleChatText` (canned replies) and the
  `mockChatEffects` chat→Surface demo;
- `dev-dispatch.ts` parses two fixed command shapes straight to the trust-wrapped outbound
  tools;
- `armReminderFromChat` and `spawnWorkerFromChat` (`server.ts`) parse reminder/research
  commands the model should be dispatching via tools.

Two seams are unfilled by design: `PiAgentRunner` takes a caller-supplied
`resolveModel: (model: ModelRef) => PiModel` it has never been given, and
`PiJsonlSessionStore` takes explicit session paths nothing constructs. `CallPurpose`
already includes `chat-turn`; `withMockFallback` adds the mock provider as a candidate only
when **no** candidate in a tier resolves a key — it is a keyless-profile fallback, not a
runtime rescue. The Gateway protocol today carries only complete `chat.message` frames
(`packages/protocol/src/gateway.ts`): streaming needs new frames, and `packages/protocol`
changes follow the repo's plan-mode rule.

Scope note: this is part I of the Agent loop wiring. Proactive completions are issue 038,
Workers and the full-text flow are issue 039, the queued Surface Agent-path consumer is
issue 040. This issue delivers the part after which _talking to your own agent with your own
key_ is possible.

## Goal

A message typed in chat reaches a real model with the full gated tool registry, streams its
answer back frame by frame, lands in the Space's Event log, and pays into the daily caps —
on any profile where a provider key resolves. Profiles without keys keep today's
deterministic behavior through the mock routing candidate, never through a parallel handler.

## Tasks

- **Provider bridge** (`resolveModel`): map a routed `ModelRef` plus its
  `SecretResolver`-resolved key onto `pi-agent-core`'s provider clients. Two additional
  providers at this layer: the existing mock (keyless profiles) and a deterministic **fake
  provider for tests** supporting text deltas, tool calls, usage reporting, and injectable
  retryable/non-retryable failures — acceptance rests on it, not on live keys. Egress
  enforcement and log redaction from issue 015 apply to the new outbound calls.
- **Sessions**: construct `PiJsonlSessionStore` under the data root (one session per Space
  plus one for the global chat; persistent, derivable IDs). Serialize turns per session —
  `PiAgentRunner` holds mutable turn state, so one turn in flight per session, later
  prompts queue (same pattern the full-text chain uses today).
- **Context assembly**: feed the live turn the assembled Space context the engine already
  produces (SOUL/USER/Space docs, FACTS, recent Event log — `spaces-engine.ts`), with
  `contextOrigins` from `SpacesEngine.contextOrigins`, `origin: 'trusted:user'`, trigger
  `{ kind: 'chat' }`. Define the global chat's context and tool scope explicitly (no Space
  log; no tools until a Space is chosen — narrowed from "L0/L1 tools only" during
  implementation because every tool in the v1 registry is Space-scoped in practice: even an
  allowlisted L1 outbound action would execute without a Space Event trail, and
  `list_templates` requires an active Space. The global chat converses and directs Space work
  to a Space).
- **Tool registry** (exact, no duplicates): trust-wrapped outbound tools,
  `store.surfaceTools()` with `gateCreateSurfaceTool` **replacing** the raw
  `create_surface`, `createMemoryTools()`, `templateTools(...)`, scheduler tools
  (`scheduler.ts`), and `spawn_worker`. Thread the `isTrustWrapped` predicate and provide
  Pi parameter schemas for every `ToolDef` offered.
- **Turn execution**: route via
  `router.execute({ purpose: 'chat-turn', origin: 'user' }, ...)` with `retryOfFailedTurn`
  on failover attempts; on `turn-end` feed `costUsd` into `router.recordSpend` (the
  proactive subsystems already record their own spend — chat turns are the missing caller).
- **Streaming protocol**: new Gateway frames for turn lifecycle (start / text delta /
  turn end / turn error) in `@veduta/protocol`, PWA accumulation into the chat log, and a
  visible in-progress state. Plan mode first (repo rule for `packages/protocol`).
- **Turn ingestion**: append the completed agent turn (and its tool calls) to the Space's
  Event log — ADR-0003's "the Agent finds user interactions before reasoning" must cover
  the Agent's own turns.
- **Remove the stand-ins**: `dev-dispatch.ts`, `handleChatText`'s canned replies,
  `mockChatEffects`, `armReminderFromChat`, `spawnWorkerFromChat` — deleted, with loopback
  behavior preserved by the mock provider candidate instead.

## Acceptance criteria

- Driven by the fake provider in integration tests: a chat message in a Space produces a
  streamed reply (start → deltas → end frames accumulate correctly in the PWA), the turn
  and its tool calls appear in the Space's Event log, and the spend is attributed to the
  right tier in `usage/` the same day.
- Trust matrix on a live turn: a trusted, allowlisted L1 action executes; a turn that reads
  untrusted stored content mid-turn is tainted and its subsequent L1+ actions become
  approval cards; an L2 action always produces an approval card.
- Failover: an injected retryable failure after the user message was appended continues the
  same session on the next candidate — one logical turn, no duplicated user message
  (`retryOfFailedTurn`), a failover record in the call log, and the session's model marker
  updated.
- Caps: with the reasoning-tier cap exhausted, a user-origin chat turn still executes;
  proactive reasoning calls are refused (per-tier semantics of `proactivityAllowed`).
- Loopback scenario parity with zero keys: meal-logging chat update, "remind me…" arming a
  timer, an outbound action producing an approval card, and `research <topic>` dispatching
  a Worker all still work end-to-end (e2e suite green with the mock candidate).
- Every chat entry point provably routes through `ModelRouter.execute` (asserted by test
  spies), and `dev-dispatch.ts` no longer exists.
- Manual smoke on `local-vps` with a BYOK key configured through the wizard: a real
  model-generated reply arrives in the browser; documented, not CI-gated.

## Dependencies

003, 010, 011, 014, 015, 017, 022, 023
