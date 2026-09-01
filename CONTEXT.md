# Veduta

A self-hosted visual personal Agent with a home-first interface: persistent Surfaces per life area maintained by a single Agent, with global chat as the editing tool.

## Language

### Structure

**Visual personal Agent**:
Veduta's product category: a personal Agent directed through chat whose ongoing work is visible, durable, and operable through Home, Spaces, and Surfaces.
_Avoid_: chatbot, chat-first assistant, dashboard builder

**Space**:
Namespace for a life area (Health, Work, Home...): holds dedicated memory, Surfaces, and Automations. Created with user confirmation, archived, never deleted.
_Avoid_: division, project, area agent, workspace

**System Space**:
The one always-active, Gateway-owned Space for Veduta's own status and controls, separate from user-created life-area Spaces. It is identified only by the shared `spc-system` identity; its name and slug are presentation values. Gateway boot alone creates or repairs it, while ordinary creation, import, rename, archive, and merge lifecycle paths cannot replace or target it. The PWA may place it in a secondary fixed-shell group by that identity but still renders its validated Atom trees through the catalog after the user drills into the Space. Every visible Surface there is daemon-owned durable living state; the Agent cannot create ordinary Surfaces or write Space memory there. User Pin and ordering remain ordinary evented presentation preferences.
_Avoid_: admin page, settings dashboard, system workspace

**Surface**:
Persistent UI unit inside a Space: a declarative tree of Atoms bound to typed state. It is _living state_, not a response.
_Avoid_: canvas, artifact, widget (ambiguous), dashboard (reserved for Home)

**Surface authoring**:
The Agent's core capability of creating, recomposing, or archiving a persistent Surface by composing validated Atoms in response to user intent. It includes keeping visually useful structured answers — such as estimates, comparisons, summaries, breakdowns, progress, plans, and timelines — persistently visible through each Space's drill-down from Home while preserving the concise chat answer. Every Model connection eligible to power the Agent provides this capability.
_Avoid_: generative UI (ambiguous), generated markup, text-only mode

**Surface presentation**:
The responsive placement of a Surface card within its Space, independent of its Atom tree and typed state. A Surface uses either `standard` or `full` presentation; `full` spans the available Space row. Presentation is also distinct from Pin, which adds stability and prominence semantics.
_Avoid_: width, CSS layout, dashboard size, Atom layout

**Home**:
The primary screen of the PWA: shows every active Space as an at-a-glance metadata summary, with each Space's Surfaces available after drill-down. It is what the user sees "at first glance upon opening".
_Avoid_: generic dashboard, feed

**Chat scope**:
The context boundary of a chat turn: global or one Space. A global turn may selectively work across multiple Spaces, while a Space-scoped turn belongs to exactly that Space.
_Avoid_: chat room, Space agent, conversation mode

**Chat timeline**:
The Gateway-owned durable, paginated user-visible conversation for one Chat scope, retained across reloads, restarts, authenticated devices, and Space archival. Veduta has one global Chat timeline and one separate timeline per Space; each contains user messages, final Agent replies, readable terminal errors, and identity-stable Pending decision feedback, but never Agent session internals, Trace details, or Event log records.
_Avoid_: session transcript, Event log, unified chat history

**Chat submission**:
One identity-stable attempt by the user to add a message to a Chat timeline. It becomes one Agent turn only after durable Gateway acceptance, and retrying the same submission never creates another turn.
_Avoid_: outgoing message, local queue entry, Agent turn before acceptance

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

**Surface commit**:
The indivisible domain outcome in which one validated Surface mutation and its matching Space Event become recoverably durable. Partial persistence is a recovery state, never a final success or failure.
_Avoid_: SQLite commit, Surface write, Event append

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
A user-confirmed, Space-owned rule that runs from confirmation onward as trigger → operation → result. The confirmed instruction defines the operation's scope, filters, and time window, including any source history it should inspect; no additional default operation is implied. It is visible and switchable off in the Space, and includes one-shot timers armed on learned deadlines.
_Avoid_: hidden cron, internal job

**Skill**:
A product-owned, versioned procedure that teaches the Agent how to perform one kind of work with the tools available to the current turn. It may guide typed tools, direct CLI/API use, and supported dependency setup; in an interactive turn the Agent selects it autonomously, while a confirmed Automation preloads its associated Skill set. Loading it grants no additional tool or credential, and its ordinary outcome is text plus validated Surface work rather than implementation detail.
_Avoid_: tool, plugin, Automation, persona

**General execution tool**:
A Veduta-owned Agent tool for directly operating external CLIs, APIs, and setup commands. It enters through AgentRunner and is available consistently across eligible Model connections; it is not a provider-native shell or a domain-specific adapter. Its breadth makes command semantics an Agent policy and audit concern rather than a universally typed capability boundary.
_Avoid_: provider shell, unrestricted provider tool

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
An action's product-policy class: L0 free (inside the daemon), L1 approval-first (toward the outside, relaxable per type), L2 never automatic (money above a threshold, destructive). Typed product tools enforce the class structurally; official Skills apply it behaviorally when using the general execution tool.

**Approval card**:
The Surface for a Pending decision over an L1+ action, already prepared and editable before approval.
_Avoid_: yes/no prompt

**Untrusted content**:
Any content of external origin (mail, web pages, webhooks). Marked as data, never as instructions. Typed tools gate its downstream effects; official Skills must require an Approval card before it contributes to an L1+ command through general execution.
_Avoid_: user input (which is a different thing)

**Quarantined reader**:
A cheap, tool-less LLM call that turns Untrusted content into schema-validated structured data for unsolicited events and unattended extraction. Explicit interactive work or direct external-tool use may instead bring bounded raw content into the current Agent turn with its origin preserved.

**Mailbox assistant**:
The user-connected mailbox capability that lets the Agent work with mail only for an explicit user request or an explicitly confirmed Automation. Connecting a mailbox never causes background checking, import, reading, summarization, Surface updates, or notifications; provider message access occurs only while serving that request or a due Automation occurrence. A mailbox Automation authorizes exactly the mail operation in its confirmed instruction and adds no implicit query or backlog. Every mail request or Automation, and all of its outcomes, belongs to exactly one Space; the same mailbox connection may be used by multiple Spaces, but no result or memory crosses between them automatically. V1 provides polished Surface flows for search, summary, Explicit mail read, and user-approved threaded reply. Other operations available through an external tool may still be performed for an explicit chat request, but have no dedicated v1 Surface action or product guarantee. Mail work stays assistive rather than becoming a Bridge, autonomous email bot, or inbox replica.
_Avoid_: email Bridge, mail bot, inbox replacement

**Mailbox connection**:
A Gateway-wide, passive authorization to access one provider mailbox. It may be named in the explicit scope of mail work owned by different Spaces, but owns no Surface, memory, notification, or Automation itself.
_Avoid_: Space mailbox, synchronized inbox

**Mailbox scope**:
The resolved boundary of explicitly authorized mail work: the target mailbox or mailboxes, provider query such as folders or labels, time window, read-state filter, result bound, and permitted mutations that matter to the request. It must be unambiguous from the instruction and current context before provider access; the Agent clarifies material gaps rather than silently widening the search.
_Avoid_: default inbox sync, implicit mailbox scan

**Mail summary**:
The durable, schema-validated projection produced by explicitly authorized mail work: provider message and thread identity, selected headers, priority, and quarantined summary, never the raw body or attachments. Raw content is processed transiently and fetched again only when later authorized work needs it.

**Explicit mail read**:
A user action in a Mailbox Surface or chat that transiently retrieves one message's raw content and marks that message read at its provider. In v1, mailbox searches, summaries, and Automation outputs leave provider read state unchanged unless the user opens a message explicitly.

**Mailbox Surface**:
A declarative Surface in a Space that presents durable mail results such as search metadata, summaries, or an editable reply draft; raw message content is displayed only for a transient explicit mail read. It is a snapshot labelled with its query and last check, and changes only through an explicit refresh interaction or its linked Automation. It may be produced by a user-requested Agent response or serve as the persistent output of a mailbox Automation; recurring occurrences update the same linked Surface instead of creating one per run. It is not an inbox replica: its actions start new Agent interactions, while provider thread identity is retained internally and sending remains governed by an Approval card.

**Gateway**:
The self-hosted daemon: serves the PWA, owns sessions, Spaces, the scheduler, event ingestion.
_Avoid_: server (generic), backend

**Bridge**:
A messenger integration such as Slack, Signal, Telegram, or WhatsApp: quick input, short text replies, notifications, and deep links to the Home without replacing the PWA as the primary visual client. Bidirectional text is the current product guarantee; any provider-native rich projection is a separate future decision.
_Avoid_: primary channel, bot (as a product), ChannelAdapter (implementation detail)

**BYOK**:
One Model connection method: the user supplies an LLM provider API key. A provider subscription is a different Model connection method.
_Avoid_: subscription login, OAuth
