# Veduta

A self-hosted personal agent with a home-first interface: persistent Surfaces per life area maintained by a single agent, with a global chat as the editing tool.

## Language

### Structure

**Space**:
Namespace for a life area (Health, Work, Home...): holds dedicated memory, Surfaces, and Automations. Created with user confirmation, archived, never deleted.
_Avoid_: division, project, area agent, workspace

**Surface**:
Persistent UI unit inside a Space: a declarative tree of Atoms bound to typed state. It is _living state_, not a response.
_Avoid_: canvas, artifact, widget (ambiguous), dashboard (reserved for Home)

**Home**:
The primary screen of the PWA: shows all Spaces with their Surfaces. It is what the user sees "at first glance upon opening".
_Avoid_: generic dashboard, feed

**Atom**:
UI component from the closed catalog (Button, Row, Chart, Checkbox... ~24 ChatKit-style + Progress, Stat, ListItem, Automation). The Agent composes Atoms, it does not generate markup.
_Avoid_: primitive (ambiguous between atom and template), custom component, HTML

**Template**:
A composition of Atoms saved in a Space and reused/patched instead of being regenerated from scratch. Emergent, not hardcoded. It carries the tree and the names of the state keys it binds, never the data.
_Avoid_: blueprint, predefined widget

**Pin**:
The user's "I like this Surface as it is": the Surface's tree is locked. The Agent keeps patching the state; a tree change becomes a Tree proposal. Reversible, and it also saves the composition as a Template.
_Avoid_: lock (alone), freeze, favourite

**Tree proposal**:
A tree change the Agent wanted to make to a pinned Surface, held for the user with a preview and an explicit Accept/Reject. Applied only on acceptance, refused if the tree moved meanwhile.
_Avoid_: pending patch, draft, suggestion

### Execution

**Local VPS profile**:
A local execution profile that exercises the same product flows as the VPS profile where possible: authentication, BYOK, persistent configuration, Gateway, PWA, Spaces, Surfaces, and real or mock model providers. User-visible flow parity is the invariant; local orchestration may differ, including Docker Compose. It replaces external VPS-only dependencies with explicit local substitutes.
_Avoid_: dev mode, staging (unless it is a remote shared environment), production mode

**Agent**:
The system's single main LLM loop. One identity (SOUL); it switches context between Spaces, not personality.
_Avoid_: orchestrator, firstmate, main assistant

**Worker**:
Ephemeral background LLM execution for asynchronous "investigate-and-report" tasks (long research, monitoring). Born with a briefing and a budget, dies delivering into the Space. Does not decide on the final output.
_Avoid_: crewmate, persistent subagent, team

**Fast path**:
A Surface interaction handled deterministically by the daemon, with no LLM: it mutates the state and logs an event to the Space's Event log.
_Avoid_: direct action, shortcut

**Agent path**:
A Surface action that requires judgment and goes through the Agent ("regenerate the plan").
_Avoid_: semantic action (in code), slow path

**Automation**:
A job or timer created by the Agent but visible to and switchable off by the user in the Space. Includes the one-shot timers armed on learned deadlines.
_Avoid_: hidden cron, internal job

**Heartbeat**:
A low-frequency periodic wake-up (1-2 times/day) that acts as a safety net for fuzzy conditions not expressible as events or timers. It is not the engine of proactivity.
_Avoid_: main polling, tick loop

### Memory

**FACTS**:
The curated file of a Space's durable facts, small and always injected into context. Bi-temporal facts: every fact carries its date. Three states: **active** (injected), **dormant** (valid and on disk, not injected, retrieved on demand), **superseded** (replaced, in `## Superseded`). Nothing is ever deleted.
_Avoid_: memory (generic), knowledge base

**Dormant**:
A FACTS state: a still-valid fact the nightly Reflection moved out of the injected set to keep it under budget. Retrievable, reversible, never deleted — it is not superseded and it is not forgetting.
_Avoid_: archived fact, expired fact, forgotten

**Hybrid index**:
The disposable SQLite FTS5 index over a Space's Event log and FACTS. It makes the long tail findable; it never answers. Every hit dereferences the original record, which is re-read from the file. Delete it and one command rebuilds it identically.
_Avoid_: vector store, knowledge base, cache (it is neither authoritative nor merely a cache)

**Retrieval**:
The read-side interface over the hybrid index: a query, a time range extracted in the user's timezone, and hits that carry the original record with its origins — growing the turn's live taint when a hit is untrusted.
_Avoid_: RAG, semantic search, lookup

**Event log**:
The append-only stream of a Space's events (from the fast path and from turns). Recent portion in context, long tail via hybrid search. It is the provenance: it is never rewritten.
_Avoid_: history, diary

**INSTRUCTIONS**:
A Space's character: tone, constraints, what not to do. Per-Space.
_Avoid_: space SOUL, division prompt

**SOUL**:
The Agent's personality, single and global.

**USER**:
The user's cross-cutting profile, injected into every context.

**Curator**:
The memory-write step that applies Add/Update/Supersede/Noop, comparing every new fact against the existing ones. Contradictions are resolved at write time, not at read time.

**Reflection**:
The offline nightly job (default 04:00 in the user's timezone) that distills the Event log into summaries and 2-3 insights, consolidates FACTS through the Curator without ever falsely superseding, and demotes the least-recently-noted still-valid facts to **dormant** until the injected set is back under budget ("sleep-time compute"). A visible Automation the user can switch off.
_Avoid_: dreaming (OpenClaw term)

### Trust and channels

**Trust level**:
An action's capability class: L0 free (inside the daemon), L1 approval-first (toward the outside, relaxable per type), L2 never automatic (money above a threshold, destructive).

**Approval card**:
The Surface with which the Agent presents an L1+ action, already prepared, editable, with explicit approval.
_Avoid_: chat confirmation, yes/no prompt

**Untrusted content**:
Any content of external origin (mail, web pages, webhooks). Marked as data, never as instructions; it cannot trigger L1+ actions without an Approval card.
_Avoid_: user input (which is a different thing)

**Quarantined reader**:
A cheap, tool-less LLM call that turns Untrusted content into schema-validated structured data. Raw external text never enters the Agent's context.

**Gateway**:
The self-hosted daemon: serves the PWA, owns sessions, Spaces, the scheduler, event ingestion.
_Avoid_: server (generic), backend

**Bridge**:
A ChannelAdapter to a messenger (Telegram/WhatsApp): quick input and notifications with deep links to the Home. Replies short, never rich content.
_Avoid_: primary channel, bot (as a product)

**BYOK**:
The user brings their own LLM provider API keys; model routing (triage/reasoning tiers) is built on top.
