# 052 — Global chat performs scoped multi-Space work

## Context

[ADR-0001](../docs/adr/0001-home-first.md) defines chat as the omnipresent input that modifies
persistent Surfaces, and [ADR-0002](../docs/adr/0002-single-agent-spaces.md) keeps one Agent while
placing hierarchy in Space-scoped data. Issue 037 narrowed the implementation in the opposite
direction: a chat turn with no open Space receives no tools and a system prompt tells the user to
navigate into a Space before Veduta can act.

That makes the global chat conversational rather than global. It also contradicts the day-one
architecture flow in which a Home request can identify an existing Space, ask when the target is
ambiguous, propose a new Space when none fits, and then create its Surfaces. **Connection parity**
([`CONTEXT.md`](../CONTEXT.md), ADR-0016) removes provider-dependent tool cliffs in issue 070; this issue removes the
remaining location-dependent cliff without introducing a persistent agent per Space.

## Goal

From the omnipresent chat, without opening a Space first, the user can ask the single Agent to read
or modify one or more Spaces. The Agent loads only the relevant Space contexts, uses explicitly
scoped Veduta tools, preserves taint and Event log provenance per Space, and leaves the user's
current PWA route unchanged while linking to the results.

## What to build

- Replace the global chat's “talking only” prompt and empty registry with one stable, provider-
  independent scoped tool registry. The global turn starts with SOUL, USER, and a bounded current
  roster of active Spaces; it does not inject every Space's FACTS, Event log, INSTRUCTIONS, or
  Surfaces up front.
- Add a read-side operation that enters an explicitly identified Space for the current turn and
  returns its normal assembled context plus origins. Validate the Space id/slug against active
  Spaces, cap the returned context through the existing context policy, and report every origin in
  the `ToolResult` so `PiAgentRunner` grows the turn's live taint before any later action. Record
  which Spaces the turn has entered; a mutation may not target a Space the Agent has not first
  entered and understood.
- Provide global, explicitly Space-scoped forms of the existing tool registry: Surface authoring,
  memory, Templates, scheduler, trust-wrapped outbound actions, and Worker spawn. Preserve the
  canonical tool behavior and trust levels rather than reimplementing handlers. Every call resolves
  its target to `ToolContext.spaceId`, rejects archived/unknown targets, and writes through the same
  validated engine and Event log path as a focused Space turn. Keep names unique and schemas stable
  for the lifetime of the global session.
- Let one turn enter and act on multiple Spaces. The main Agent performs cross-Space coordination;
  there is no per-Space Agent, nested AgentRunner, or mandatory handoff. A Worker remains scoped to
  one Space and to asynchronous investigate-and-report work; the Agent may spawn separate Workers
  when a cross-Space request contains independent long-running investigations, then owns the final
  decision.
- Resolve targets from user intent with an explicit policy: act directly when one existing Space is
  unambiguous; ask the user when multiple targets are plausible; never choose silently on
  ambiguity. When no existing Space fits, render the existing one-tap Space proposal flow and do
  not create the Space or its initial Surfaces before confirmation.
- Give every global turn a stable correlation id. Append the relevant user turn, tool calls,
  terminal outcome, and mutations to each Space the turn actually enters, carrying the same
  correlation id so a cross-Space request is recognizable without a shared Event log. Never append
  the turn to Spaces that were merely listed or considered, and never let one Space's failure erase
  an already durable event in another.
- Preserve focused-Space chat behavior: opening a Space still pre-scopes the chat and supplies that
  Space's normal registry without requiring explicit targeting on every call. Global and focused
  paths use the same underlying handlers, validation, trust gates, session semantics, and selected
  Model connection.
- Extend the completed chat response with structured result targets (Space and optional Surface)
  sufficient for the PWA to render short accessible links such as “Open Health · Weight tracker”.
  Do not navigate automatically. A currently visible Surface updates through the existing live
  Surface stream; otherwise the current route and focus remain unchanged.
- Cover routing and isolation with deterministic AgentRunner scenarios: one obvious Space, an
  ambiguous request, a confirmed new Space, two Spaces read and mutated in one turn, an unknown or
  archived target, attempted blind mutation before context entry, live-taint growth from either
  Space, a partial cross-Space failure, a scoped Worker, and a focused-Space regression.

## Acceptance criteria

- [ ] **No-navigation Surface authoring:** from Home, “create a weight tracker in Health” enters
      Health, creates a protocol-valid Surface, records the turn and mutation in Health's Event log,
      leaves the current route unchanged, and renders a working link to the new Surface.
- [ ] **Cross-Space turn:** “compare Work deadlines with Health training and update both plans”
      loads only Work and Health, can patch both in one logical turn, assigns every call and Event
      log entry to the correct Space, and carries one correlation id across the two logs.
- [ ] **Honest targeting:** an unambiguous existing target acts without an extra confirmation; an
      ambiguous fixture asks and writes nothing; a missing life area uses one-tap Space proposal and
      creates neither Space nor Surface before acceptance.
- [ ] **Isolation and trust:** no unrelated Space context enters the model request, a mutation before
      entering its target is refused, and untrusted content read from either entered Space taints all
      later calls in that turn according to the existing L1/L2 matrix.
- [ ] **Still one Agent:** no persistent or per-Space agent, nested AgentRunner, worker-to-worker
      handoff, or duplicate tool implementation is introduced. Workers remain ephemeral,
      Space-scoped, asynchronous investigate-and-report executions.
- [ ] **Stable UI:** global mutations never navigate automatically; visible Surfaces update live and
      off-screen results produce accessible Space/Surface links. Focused-Space chat continues to
      behave as before.
- [ ] The same scenarios pass with every primary Model connection contract, including the Codex
      subscription path from issue 070, followed by `pnpm lint`, `pnpm format:check`,
      `pnpm typecheck`, `pnpm test`, and `pnpm build`.

## Out of scope

- Persistent agents, managers, personalities, or sessions per Space beyond the existing focused
  chat session.
- Broadening Workers beyond asynchronous investigate-and-report work, allowing Worker-to-Worker
  calls, or letting Workers make the final decision.
- Injecting all Space memory into every global turn, building a cross-Space knowledge graph, or
  creating a shared mutable Event log.
- Automatically navigating the PWA after an Agent mutation or redesigning Home, chat, or Model
  connection settings.
- Provider-specific global-chat behavior; issue 070 must make the selected connection capability-
  invariant first.

## Blocked by

[070 — ChatGPT subscription tool parity](070-codex-tool-parity.md). Also builds on completed issues
[006](006-spaces-engine-memory.md), [009](009-pwa-home-chat.md),
[014](014-trust-layer.md), [017](017-worker-review.md), and [037](037-agent-loop-chat.md), and on
[ADR-0002](../docs/adr/0002-single-agent-spaces.md).
