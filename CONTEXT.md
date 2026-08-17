# Veduta

A self-hosted personal agent with a home-first interface: persistent Surfaces per life area maintained by a single agent, with a global chat as the editing tool.

## Language

### Structure

**Space**:
Namespace for a life area (Health, Work, Home...): holds dedicated memory, Surfaces, and Automations. Created with user confirmation, archived, never deleted.
_Avoid_: division, project, area agent, workspace

**System Space**:
The one always-active, Gateway-owned Space for Veduta's own status and controls, separate from user-created life-area Spaces. Every visible Surface there is daemon-owned durable living state; the Agent cannot create ordinary Surfaces or write Space memory there.
_Avoid_: admin page, settings dashboard, system workspace

**Surface**:
Persistent UI unit inside a Space: a declarative tree of Atoms bound to typed state. It is _living state_, not a response.
_Avoid_: canvas, artifact, widget (ambiguous), dashboard (reserved for Home)

**Surface authoring**:
The Agent's core capability of creating or modifying a persistent Surface by composing validated Atoms in response to user intent. Every Model connection eligible to power the Agent provides this capability.
_Avoid_: generative UI (ambiguous), generated markup, text-only mode

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
The user's "keep this Surface stable and prominent": the Surface belongs to a separate, shared pinned group at the top of its Space; the newest pin appears first, the user may reorder within that group, and removing the pin places the Surface first in the regular group. Its tree is locked while state keeps updating, a tree change becomes a Tree proposal, and the reversible pin also saves the composition as a Template.
_Avoid_: lock (alone), freeze, favourite

**Tree proposal**:
A tree change the Agent wanted to make to a pinned Surface, held for the user with a preview and an explicit Accept/Reject. Applied only on acceptance, refused if the tree moved meanwhile.
_Avoid_: pending patch, draft, suggestion

### Execution

**Loopback profile**:
The lightweight development profile (`pnpm dev`): loopback-only, no authentication, mock provider, seed data. It exists to iterate on code, not to rehearse the product.
_Avoid_: dev mode, Local VPS profile (a different thing), test mode

**VPS profile**:
The production deployment profile: the Gateway runs on a VPS with passkey authentication, hardened systemd supervision, persistent data, and self-updates. It does not imply public exposure; the installation chooses Public, Tunnel, or Tailnet access.
_Avoid_: production mode, prod

**Public access**:
A VPS access mode in which the Gateway is reached through a stable public domain, binds to public interfaces, and manages HTTPS certificates through ACME. The domain is the WebAuthn origin and RP ID.
_Avoid_: VPS profile (the execution profile supports more than one access mode), public profile

**Tunnel access**:
A VPS access mode in which the Gateway binds only to loopback and the browser reaches it through an SSH local forward at a stable `http://localhost:<port>` origin. It needs neither a public domain nor ACME; passkey authentication remains enabled.
_Avoid_: Local VPS profile (a development profile), unauthenticated mode, SSH profile

**Tailnet access**:
A VPS access mode in which Tailscale Serve gives authorized tailnet devices a stable HTTPS origin while the Gateway remains bound to loopback. It supports browsers and phones without exposing a public port. Tailscale Funnel is not this mode and must never be enabled implicitly.
_Avoid_: Tunnel access (device-local SSH forwarding), public access, Tailscale Funnel

**Local VPS profile**:
A local execution profile that exercises the same product flows as the VPS profile where possible: authentication, Model connections, persistent configuration, Gateway, PWA, Spaces, Surfaces, and real or mock model providers. User-visible flow parity is the invariant; local orchestration may differ, including Docker Compose. It replaces external VPS-only dependencies with explicit local substitutes.
_Avoid_: dev mode, staging (unless it is a remote shared environment), production mode

**Agent**:
The system's single main LLM loop. One identity (SOUL), including one global user-chosen name; it selectively works across one or more Space contexts, not per-Space personalities. Its name may differ from Veduta, which remains the product name.
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

**Trace**:
A bounded, redacted diagnostic record that links one operation to its meaningful steps through a
`traceId`. It helps the user locate runtime failures but is not business state, provenance, an
audit guarantee, or model chain of thought; an explicit gap is valid when diagnostics were lost.
_Avoid_: Event log, audit log, history, chain of thought

**Runtime log**:
The installation-wide rotating technical stream emitted by the Gateway at DEBUG, INFO, WARN, and
ERROR levels. It can carry a `traceId` for correlation but remains distinct from both a Trace and a
Space's Event log.
_Avoid_: Event log, Trace, activity history

**Model connection**:
A Gateway-wide configured route that lets the Agent use a model through either a provider subscription or BYOK. It is shared by every Space and supplies inference only; the Agent loop and its tools remain inside Veduta.
_Avoid_: provider login (only one possible setup method), agent runtime

**Connection parity**:
The product invariant that changing provider, model, or authorization method leaves the Agent's Veduta capabilities, workflows, and persistent outcomes unchanged. Only unavoidable connection properties such as authentication, catalog, price, latency, limits, and model quality may differ.
_Avoid_: provider mode, text-only mode, degraded connection

**Automation**:
A job or timer created by the Agent but visible to and switchable off by the user in the Space. Includes the one-shot timers armed on learned deadlines.
_Avoid_: hidden cron, internal job

**Automation outcome**:
The user-relevant result of an Automation occurrence: a meaningful change, failure, recovery, or required decision. Routine checks with no change advance freshness but are not outcomes.
_Avoid_: scheduled briefing, polling message

**Automation run history**:
The bounded, user-facing sequence of an Automation's meaningful outcomes and errors. Routine checks appear only through freshness, while the append-only Event log remains the complete provenance.
_Avoid_: Activity, chat history, Event log

**Website monitor**:
A recurring Automation that applies a user-confirmed monitoring goal to public content on an approved set of hosts and writes structured outcomes to one Surface in the same Space. It discovers relevant same-site pages through quarantined reading; it is not general web search.
_Avoid_: browser agent, scraper, web search

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
A user-controlled Space's character: tone, constraints, what not to do. It specializes how the single Agent behaves there without creating a separate identity; product-owned rules remain separate.
_Avoid_: space SOUL, division prompt

**SOUL**:
The Agent's user-controlled global identity: name, personality, baseline tone, and global character preferences. It applies across every Space; product-owned rules remain separate.

**Character change**:
A persistent, user-initiated replacement of exactly one character document: either `SOUL.md` or one Space's `INSTRUCTIONS.md`. The Agent splits a multi-scope request into independent changes, then presents each target and complete diff as a Pending decision; acceptance applies it atomically only while its starting revision is current. It affects context assembled after the authoritative resolution, never a model call already in progress.
_Avoid_: temporary personality, personality overlay, self-evolution

**Identity onboarding**:
The optional, one-time invitation included in the Agent's first global-chat response while `SOUL.md` is still pristine; it never starts an autonomous turn or blocks a substantive first request. It asks how the Agent should be named and what kind of presence it should be, then uses the ordinary Character-change proposal and confirmation flow. Skipping or ignoring it keeps the default identity and never prompts again; an imported or already-customized identity bypasses it.
_Avoid_: profile setup, personality wizard, onboarding form

**USER**:
The user's cross-cutting profile, injected into every context.

**Curator**:
The memory-write step that applies Add/Update/Supersede/Noop, comparing every new fact against the existing ones. Contradictions are resolved at write time, not at read time.

**Reflection**:
The offline nightly job (default 04:00 in the user's timezone) that distills the Event log into summaries and 2-3 insights, consolidates FACTS through the Curator without ever falsely superseding, and demotes the least-recently-noted still-valid facts to **dormant** until the injected set is back under budget ("sleep-time compute"). A visible Automation the user can switch off.
_Avoid_: dreaming (OpenClaw term)

### Trust and channels

**Pending decision**:
A daemon-owned request for one explicit user choice, identified durably and resolved exactly once. Its Surface, notification, and chat affordances are channels to the same decision.
_Avoid_: chat confirmation, model approval

**In-app notification**:
A durable, dismissible attention item shown inside its owning Space and deep-linked to the affected Surface. It is distinct from a Space attention badge, browser push, and assistant chat message.
_Avoid_: push notification, chat notice, badge

**Trust level**:
An action's capability class: L0 free (inside the daemon), L1 approval-first (toward the outside, relaxable per type), L2 never automatic (money above a threshold, destructive).

**Approval card**:
The Surface for a Pending decision over an L1+ action, already prepared and editable before approval.
_Avoid_: yes/no prompt

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
One Model connection method: the user supplies an LLM provider API key. A provider subscription is a different Model connection method.
_Avoid_: subscription login, OAuth
