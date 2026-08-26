# Research 17 — Veduta versus AG-UI over Hermes Agent

> Conducted on 2026-08-25 from primary sources. Historical comparisons use the last AG-UI and
> Hermes Agent commits available before Veduta's founding architecture commit; present-day
> comparisons use pinned current revisions. Statements marked **Inference** are architectural
> conclusions drawn from those sources rather than claims made by the projects themselves.

## Executive finding

The exact alternative “AG-UI over Hermes Agent” was not evaluated in Veduta's recorded decisions.
Before this report, a repository-wide search at `2cffa0a` found no AG-UI or CopilotKit reference.
AG-UI was already available when Veduta's founding architecture was committed on 2026-07-03, so
unavailability is not a defensible explanation. This is a real gap in the decision record, not a
rejected option whose rationale can be reconstructed as fact.
([Veduta founding commit](https://github.com/Ic3b3rg/veduta/commit/7b5f4186622af88c8c0847c6b85fceece8380df9),
[AG-UI release history](https://github.com/ag-ui-protocol/ag-ui/releases/tag/release%2F2026-03-28))

The proposed stack is also less complete than it first appears:

- **AG-UI is not a UI tree or renderer.** It standardizes the bidirectional runtime boundary
  between an Agent and an application. Its own documentation identifies A2UI, Open-JSON-UI, and
  MCP-UI as the UI specifications that AG-UI can transport.
  ([AG-UI terminology](https://github.com/ag-ui-protocol/ag-ui/blob/17f1ffdac89f6c6a08485f2de59be60ef912a65f/docs/concepts/generative-ui-specs.mdx))
- **Hermes is an Agent runtime and product**, owning its loop, provider routing, tools, sessions,
  memory, scheduler, approvals, and channels. It is not an inference-only backend.
  ([Hermes architecture](https://github.com/NousResearch/hermes-agent/blob/1bbb6e5bce56e721ab685af4cd87df21bbff4d35/website/docs/developer-guide/architecture.md))
- **Veduta's differentiator lives above and across both layers**: the persistent Home, Spaces,
  validated Surfaces, fast path, per-Space Event log, Templates, Automations, trust policy, and the
  rule that every primary Model connection authors the same durable product state.
  ([architecture](../../ARCHITECTURE.md), [vocabulary](../../CONTEXT.md))

Consequently, AG-UI plus Hermes could have produced a convincing chat-and-UI prototype faster.
It would not have produced Veduta as specified without a substantial Veduta domain service,
renderer, persistence layer, and policy adapter. For the current codebase, a full Hermes migration
would move complexity across a Python/process boundary and create competing authorities. A thin
AG-UI compatibility adapter is more plausible, but it is valuable only when Veduta has a concrete
interoperability consumer.

## Source snapshots and method

The relevant historical instant is 2026-07-03, when Veduta committed its founding architecture,
glossary, ADRs, and initial research in `7b5f418`.

- AG-UI is inspected at
  [`c2c6430`](https://github.com/ag-ui-protocol/ag-ui/tree/c2c6430d75804a56b896679910778eaa46012dc1),
  the last commit before that Veduta decision, and at current
  [`17f1ffd`](https://github.com/ag-ui-protocol/ag-ui/tree/17f1ffdac89f6c6a08485f2de59be60ef912a65f).
- Hermes Agent is inspected at
  [`1042329`](https://github.com/NousResearch/hermes-agent/tree/104232979d6ec24e82a42dfbf14ac98f3df3c827),
  the last commit before the decision, and at current
  [`1bbb6e5`](https://github.com/NousResearch/hermes-agent/tree/1bbb6e5bce56e721ab685af4cd87df21bbff4d35).
- Veduta's internal responsibilities come from its accepted ADRs, protocol source, and existing
  primary-source research on Hermes. No intent is inferred merely from an absent document.

The historical AG-UI architecture already described an Agent/application event boundary with
run lifecycle, streamed text, tool-call, state snapshot/delta, message snapshot, raw, and custom
events. Its integration tree included several runtimes but not Hermes.
([historical architecture](https://github.com/ag-ui-protocol/ag-ui/blob/c2c6430d75804a56b896679910778eaa46012dc1/docs/concepts/architecture.mdx),
[historical integrations](https://github.com/ag-ui-protocol/ag-ui/tree/c2c6430d75804a56b896679910778eaa46012dc1/integrations))

At the same instant, Hermes already had a single `AIAgent` loop, provider resolution, tool
dispatch, compression, SQLite/FTS5 sessions, a messaging Gateway, cron, and multiple programmatic
interfaces. Its documented external protocols were ACP, its own JSON-RPC Gateway, and an
OpenAI-compatible HTTP/SSE API—not AG-UI.
([historical architecture](https://github.com/NousResearch/hermes-agent/blob/104232979d6ec24e82a42dfbf14ac98f3df3c827/website/docs/developer-guide/architecture.md),
[historical programmatic interfaces](https://github.com/NousResearch/hermes-agent/blob/104232979d6ec24e82a42dfbf14ac98f3df3c827/website/docs/developer-guide/programmatic-integration.md))

Current source preserves the same absence: Hermes still documents ACP, JSON-RPC, and HTTP/SSE,
while AG-UI's first-party integration directory still has no Hermes adapter.
([current Hermes interfaces](https://github.com/NousResearch/hermes-agent/blob/1bbb6e5bce56e721ab685af4cd87df21bbff4d35/website/docs/developer-guide/programmatic-integration.md),
[current AG-UI integrations](https://github.com/ag-ui-protocol/ag-ui/tree/17f1ffdac89f6c6a08485f2de59be60ef912a65f/integrations))

## The four layers that the proposed shortcut conflates

| Layer                              | What owns it in the proposed stack                       | What owns it in Veduta                                                  |
| ---------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| Product and domain                 | Still missing                                            | Space, Surface, Home, Automation, Event log, trust and memory contracts |
| Declarative UI format and renderer | A2UI or another format plus a renderer; not AG-UI itself | `@veduta/protocol` Atom/Surface schemas plus `@veduta/catalog`          |
| Agent/application interaction      | AG-UI                                                    | Veduta's typed HTTP/WebSocket Gateway contract                          |
| Agent runtime                      | Hermes Agent                                             | `AgentRunner`, currently implemented with wrapped `pi-agent-core`       |

The actual alternative was therefore not two pieces. It was at least:

```text
Veduta Home and catalog renderer
  ↕ A2UI or another validated Surface format
AG-UI client and event protocol
  ↕ custom Hermes ↔ AG-UI adapter
Hermes Agent
  ↕ Veduta-specific tools, policy, and persistence
Veduta Space / Surface / Event / Automation domain service
```

CopilotKit or another client kit could supply additional frontend plumbing, but AG-UI alone does
not provide the application shell, durable Home, catalog design, or domain state.

## Responsibility matrix

“Carries” means a protocol can transport a value but does not define its product semantics or
authoritative storage.

| Responsibility                                   | AG-UI                                                  | Hermes Agent                                              | Veduta                                                           |
| ------------------------------------------------ | ------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Run lifecycle and streamed text                  | Standardizes events                                    | Produces native stream events                             | Custom `chat.turn-*` frames                                      |
| Tool-call progress                               | Standardizes events                                    | Owns tool registry and execution                          | AgentRunner owns validated `ToolDef` execution                   |
| Agent/application state sync                     | Carries snapshots and JSON Patch deltas                | Exposes runtime/session state through its interfaces      | Owns authoritative Surface snapshots, cursors, and typed events  |
| Declarative UI tree                              | Explicitly delegates to A2UI or another format         | No Veduta-compatible Surface contract                     | Closed Atom catalog and validated Surface tree                   |
| Persistent multi-area Home                       | No                                                     | No                                                        | Core product thesis: Spaces containing living Surfaces           |
| Surface lifecycle and ordering                   | No                                                     | No                                                        | Create, patch, archive, pin, move, freshness, and replay         |
| Deterministic interaction without an LLM         | No product semantics                                   | Generic tools can run without defining Veduta's fast path | Fast path mutates state and appends the Space Event              |
| Durable domain provenance                        | Serialized run streams, not a Space business log       | Sessions and operational evidence                         | Append-only per-Space Event log                                  |
| Agent loop, model providers, retries, compaction | No                                                     | Yes                                                       | Yes, behind `AgentRunner` and Model connections                  |
| Sessions                                         | Defines thread/run identifiers and serializable events | SQLite/FTS5 session authority                             | Veduta-owned `SessionStore` contract                             |
| Personal memory                                  | No                                                     | Yes, under Hermes semantics                               | FACTS, dormant/superseded states, retrieval, and Reflection      |
| Scheduling                                       | No                                                     | Cron and scheduled Agent tasks                            | Space-owned Automations, timers, outcomes, and Event entries     |
| Skills and broad tools                           | No                                                     | Large catalog, plugins, terminal and MCP                  | First-party Skills and Veduta-owned general execution            |
| Approval and human input transport               | Interrupt and tool-event primitives                    | Hermes approval/clarification flows                       | Pending decisions plus L0/L1/L2 and origin-aware policy          |
| Authentication and deployment                    | Leaves to application/transport                        | Hermes profiles, Gateway and clients                      | VPS/loopback profiles, passkeys, device pairing, and self-update |
| Messenger channels                               | No                                                     | Many native adapters                                      | Deliberately thin post-v1 Bridges                                |

AG-UI's shared state deserves special care in this comparison. The protocol supplies
`STATE_SNAPSHOT` with an unconstrained state value and `STATE_DELTA` with RFC 6902 operations. It
also documents event-stream serialization and compaction, leaving the example storage to the
application. Those are useful wire and replay mechanisms, not a schema, conflict policy, domain
store, or authorization model.
([state management](https://github.com/ag-ui-protocol/ag-ui/blob/17f1ffdac89f6c6a08485f2de59be60ef912a65f/docs/concepts/state.mdx),
[serialization](https://github.com/ag-ui-protocol/ag-ui/blob/17f1ffdac89f6c6a08485f2de59be60ef912a65f/docs/concepts/serialization.mdx))

Veduta's corresponding protocol validates the complete Surface, checks Atom bindings against
state, distinguishes state and tree patches, assigns authoritative cursors, and carries domain
events for creation, archival, pinning, movement, and freshness.
([Surface schema](../../packages/protocol/src/surface.ts),
[patch schema](../../packages/protocol/src/patch.ts),
[Gateway schema](../../packages/protocol/src/gateway.ts))

## Where the overlap is real

### AG-UI overlaps with Veduta's Gateway boundary

Veduta's `chat.turn-start`, `chat.turn-delta`, `chat.turn-end`, and `chat.turn-error` frames map
closely to AG-UI run and text-message events. Tool progress, future steering, and parts of Pending
decision presentation also have AG-UI equivalents. A standard client could replace some custom
stream reduction and make external inspectors or alternate clients easier to attach.

The overlap is narrower for durable product state. Veduta's `surface.created`, `surface.patch`,
`surface.archived`, `surface.pinned`, `surface.moved`, Space attention, presence, and authoritative
ordering still need either:

1. Veduta-specific `CUSTOM` events;
2. a carefully defined projection into one AG-UI state document; or
3. a separate domain API beside the AG-UI run stream.

**Inference:** option 1 gains ecosystem compatibility while retaining two semantic layers; option
2 risks hiding strong domain invariants inside generic JSON Patch; option 3 preserves clarity but
does not simplify the number of integration points. AG-UI can standardize the envelope, but it
cannot remove the Veduta payloads.

### Hermes overlaps with Veduta's runtime and infrastructure

Hermes could replace or accelerate substantial generic infrastructure:

- the Agent loop, provider selection, retries, streaming, and compaction;
- session persistence and search;
- tool, Skill, plugin, terminal, browser, and MCP infrastructure;
- cron, background work, channels, approvals, diagnostics, and setup.

This is the strongest case for the alternative. Veduta's own early research already recognized
Hermes as a mature single-Agent, multi-provider, multi-channel system and later adopted several of
its patterns selectively.
([baseline research](01-sota-hermes-openclaw.md),
[observability research](09-hermes-human-observability.md),
[Skill research](16-hermes-skills-architecture.md))

The overlap also creates the central ownership conflict. Veduta requires the same AgentRunner
contract for every primary Model connection and keeps tool execution, trust decisions, Event log
writes, and Surface changes inside Veduta. Hermes's value comes from owning those same parts as a
coherent Agent. Treating Hermes as an inference-only connection would discard most of its value;
letting it remain the Agent would replace—not implement—the boundary in ADR-0014 and ADR-0016.
([runtime decision](../adr/0004-typescript-pi-agent-core.md),
[inference-only boundary](../adr/0014-subscription-inference-boundary.md),
[primary connection contract](../adr/0016-primary-agent-connections-author-surfaces.md))

## What remains specifically Veduta

### Home-first product semantics

Veduta explicitly rejects a chat stream enriched with visual responses as its primary interface.
The Home shows persistent Surfaces grouped by life-area Space; chat is an editing input for that
state. Neither AG-UI nor Hermes defines that information architecture or its lifecycle.
([ADR-0001](../adr/0001-home-first.md))

### Surface integrity and direct interaction

The Agent composes a closed catalog rather than markup. Every persisted and rendered Surface is
schema-validated. A fast-path interaction changes typed state without an LLM and must append an
Event the Agent reads before later reasoning. Pins, Tree proposals, Templates, progressive Pending
Atoms, freshness, and relative-time validity extend that durable contract.
([ADR-0003](../adr/0003-declarative-atoms.md),
[ADR-0012](../adr/0012-emergent-templates.md))

AG-UI can carry these updates and A2UI can inform their wire representation. Neither establishes
the rules. Veduta already chose an A2UI-inspired mapping rather than direct conformance, so adopting
AG-UI would not automatically make current Surfaces A2UI-compatible.

### Space memory and provenance

Veduta's FACTS states, per-Space Event log, disposable index, conservative Curator, and Reflection
are product semantics rather than generic Agent memory. Replacing them with Hermes memory would
change what is authoritative and how provenance, dormant facts, retrieval, and context boundaries
work.
([ADR-0006](../adr/0006-file-based-memory.md),
[ADR-0011](../adr/0011-disposable-hybrid-index.md))

### Automation and trust

Hermes cron can wake an Agent, and AG-UI can present progress or an interrupt. Veduta additionally
requires each Automation to be Space-owned and visible, to preserve its confirmed operation and
scope, to append provenance, and to update one living Surface with disciplined notification
outcomes. Its Pending decisions delegate resolution to the workflow that owns the state; a UI
event is never itself authority.
([ADR-0005](../adr/0005-event-driven-proactivity.md),
[ADR-0019](../adr/0019-channel-neutral-pending-decisions.md),
[ADR-0021](../adr/0021-space-owned-automation-outcomes.md))

The L0/L1/L2 policy, content origins, live taint, quarantined reader, and Approval cards similarly
remain application rules. Generic Hermes approvals or AG-UI interrupts can render the interaction
but cannot silently replace those enforcement and persistence contracts.
([ADR-0007](../adr/0007-trust-levels.md), [security model](../SECURITY.md))

## Why it was not built that way

### Documented facts

1. The exact option is absent from the ADRs and research available at the founding commit.
2. AG-UI existed and already exposed its core event architecture.
3. There was no first-party Hermes AG-UI adapter; composing them required a custom translation
   layer.
4. Veduta explicitly selected TypeScript throughout and a small, wrapped TypeScript Agent runtime.
   Hermes is a much broader Python system.
5. Veduta explicitly selected a persistent Home instead of a chat-first product and selected an
   A2UI-inspired Surface format separately from the Agent/application transport.

Therefore the only historically honest answer is: **the combination was overlooked or left
implicit, not formally rejected**.

### Architectural inference

Had it been evaluated, the likely objection would not have been lack of features. Hermes had many
of the generic features Veduta needed. The objection would have been ownership:

- If Hermes owned tools, sessions, memory, cron, approvals, and channels, Veduta would have had to
  adapt its product invariants to Hermes or maintain a long-lived fork/plugin at deep seams.
- If Veduta kept those responsibilities authoritative, Hermes would have been reduced mostly to an
  Agent loop and provider adapter while its other subsystems became redundant.
- A process boundary would replace Veduta's one-language design and make cancellation, dynamic
  tools, origin tracking, session identity, upgrades, and failures cross-runtime concerns.
- AG-UI would standardize the stream between the two sides but would not resolve which side owns
  state or policy.

That is complexity relocation, not elimination.

### The counterfactual where it would have been simpler

If the immediate goal had been “validate that people want a persistent visual layer over a capable
personal Agent,” a Hermes-backed prototype was the simpler path. Hermes could have supplied the
working Agent, providers, tools, memory, and scheduling while a thin Veduta experiment concentrated
on Home and Surface authoring. The prototype could then have answered which invariants users
actually valued before the production architecture was fixed.

This does not prove that production Veduta should depend on Hermes. It does mean the founding work
should ideally have contained a narrow Hermes plus AG-UI/A2UI spike and an ADR recording its
results. The missing experiment is the strongest criticism supported by the evidence.

## Would adoption simplify Veduta today?

| Option                                         | What it removes                                       | What it adds or preserves                                                                                       | Assessment                                                         |
| ---------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Keep the current boundary                      | No migration cost                                     | Custom chat/run protocol remains                                                                                | Reasonable while one PWA is the only consumer                      |
| Add an AG-UI compatibility adapter             | Some custom client integration for external consumers | Mapping, versioning, domain custom events, dual-protocol tests                                                  | Recommended only for a named interoperability use case             |
| Make AG-UI the canonical run envelope          | Custom lifecycle/text/tool event vocabulary           | Veduta domain schemas, HTTP reads, auth, replay, and likely custom events remain                                | Plausible before v1, but not yet justified by simplification alone |
| Add Hermes as an alternate AgentRunner         | Potential provider/loop/session reuse                 | Python process, static/dynamic tool bridge, duplicated ownership, parity tests                                  | Prototype only                                                     |
| Replace Veduta's Agent and Gateway with Hermes | Much generic infrastructure                           | Rebuild or relax Space, Surface, Event, Automation, trust, auth, update, and connection contracts around Hermes | Architectural pivot, not an incremental migration                  |

AG-UI adoption has the cleaner risk profile because it can remain an edge adapter. Its value rises
when Veduta needs a third-party client, standard Agent inspector, alternate frontend, or external
Agent backend. Without such a consumer, the existing typed Gateway union is small compared with
the domain engine, and replacing its names does not materially simplify the product.

Hermes adoption has larger theoretical savings and much larger semantic cost. It should not be
introduced as a Model connection: a Model connection supplies inference only, while Hermes is an
Agent with its own tool loop and state. A Hermes experiment must instead be framed explicitly as a
candidate replacement implementation of `AgentRunner` or as a product-architecture pivot.

## Recommended decision

1. **Keep Veduta authoritative** for Spaces, Surfaces, Event logs, Automations, Pending decisions,
   trust, memory, and Model connection policy.
2. **Do not migrate to Hermes now.** Current work has already paid for and tested the strong
   contracts that Hermes would overlap. A migration would be justified only by measured runtime
   maintenance cost or a deliberate decision to relax those contracts.
3. **Record AG-UI as a missed founding option and a compatibility candidate.** Do not claim the
   current custom Surface protocol is AG-UI or directly A2UI-conformant.
4. **Run one bounded prototype before deciding on AG-UI adoption.** Keep it outside production
   code until it demonstrates a concrete benefit.
5. **Revisit Hermes only if the product goal changes** from “Veduta owns one consistent Agent and
   its durable state” to “Veduta is primarily a visual client for an independently owned personal
   Agent runtime.” That is the real decision boundary.

## Bounded prototype that would answer the remaining question

The useful prototype is not a generic chat demo. It should exercise one complete Veduta invariant:

1. Start a focused request through an AG-UI client.
2. Translate the run to Hermes without patching Hermes core.
3. Let Hermes call Veduta-owned `create_surface` and `patch_state` tools.
4. Stream run, text, and tool events back through AG-UI.
5. Persist and reload the Surface without invoking the Agent.
6. Toggle a checkbox through the fast path and prove that the Space Event is appended.
7. Exercise one L1 Pending decision and prove the owning Veduta workflow—not the AG-UI event or
   Hermes approval record—remains authoritative.
8. Reconnect a second client and prove cursor/order convergence.

The experiment should measure:

- adapter production and test code;
- duplicated identifiers and stores;
- number of processes and independent upgrade boundaries;
- cancellation and restart behavior;
- whether any Veduta invariant requires a Hermes fork or private patch;
- how many Gateway messages become standard AG-UI events versus remain Veduta-specific.

Adopt the adapter only if it stays a shallow translation, survives reload without an Agent run,
and produces a concrete external-client or tooling benefit. Reject it if it creates a second
authority, requires a Hermes fork, or represents most durable events as opaque custom payloads.

## Bottom line

Veduta was not built on AG-UI over Hermes because that exact option was never formally examined,
not because the components were unavailable. That omission should be acknowledged.

The architecture is nevertheless not equivalent. AG-UI is the interaction wire, Hermes is the
Agent runtime, and Veduta's product is the durable home-first state and policy spanning both. The
alternative would have been excellent for proving the idea quickly; under Veduta's accepted
contracts, it would save generic infrastructure while moving the hardest integration, ownership,
and trust problems into adapters and plugins. Today, experiment with AG-UI at the edge if a real
consumer exists; do not replace Veduta with Hermes unless the product itself is intentionally
redefined as a client of Hermes.
