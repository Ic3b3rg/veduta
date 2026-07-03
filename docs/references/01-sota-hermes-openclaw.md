# Research 01 — Architectures of SOTA personal agents (Hermes, OpenClaw)

> Conducted on 2026-07-02 from official documentation. Serves as a baseline: what the two market references do.

## Hermes Agent (Nous Research)

**Sources:** https://hermes-agent.nousresearch.com/docs/developer-guide/architecture · gateway-internals · prompt-assembly · cron-internals

- **Core loop:** single `AIAgent` class (`run_agent.py`): provider selection → prompt construction → API call → tool execution → retry/fallback → compression → persistence. The same loop is reused in 5 contexts: CLI, gateway, ACP, batch, API.
- **Sessions/context:** SQLite with FTS5, parent/child lineage tracking across compressions, atomic writes. Structured session keys `agent:main:{platform}:{chat_type}:{chat_id}`. Compression summarizes the middle turns while preserving prompt-caching boundaries.
- **3-tier prompt** (for caching): _stable_ (identity from `SOUL.md`, tool guidance, skill index) → _context_ (project files `.hermes.md` > `AGENTS.md` > `CLAUDE.md` > `.cursorrules`, truncated to 20k chars, security-scanned) → _volatile_ (`MEMORY.md`, `USER.md`, external memories, timestamp).
- **Memory:** file-based (`MEMORY.md`, `USER.md`) in the volatile tier; pluggable external providers in `plugins/memory/` (one active at a time).
- **Tools/skills:** registry with 70+ tools across 28 toolsets, auto-registration. Terminal with 6 backends (local, Docker, SSH, Daytona, Modal, Singularity). Skills as slash commands.
- **Single vs multi-agent:** fundamentally **single-agent**; delegates to subagents via `delegate_tool.py`, no multi-persona orchestration.
- **Channels:** gateway with **20 adapters** (Telegram, WhatsApp, Discord, Slack, Signal, Matrix, Email, SMS, WeChat...) all extending `BasePlatformAdapter` (`connect/disconnect`, `send_message`, `on_message` → normalized `MessageEvent`). 5-level authorization, DM pairing with codes. Double concurrency guard with a message queue and interrupts.
- **Scheduling:** cron in `~/.hermes/cron/jobs.json`, 4 formats, 60s tick loop with file lock; jobs run in a fresh isolated session, multi-platform delivery. Managed provider **Chronos** (Nous) for scale-to-zero with one-shot timers.
- **Model routing:** `runtime_provider.py` resolves `(provider, model)` for 18+ providers, OAuth, credential pool; 3 api_modes.

## OpenClaw (formerly Clawdbot/Moltbot, Peter Steinberger)

**Sources:** https://docs.openclaw.ai/concepts/architecture · /concepts/memory · /concepts/session · https://github.com/openclaw/openclaw

- **Gateway/channels:** one daemon per host owns all surfaces: WhatsApp via Baileys, Telegram via grammY, plus Slack, Discord, Signal, iMessage, WebChat. Typed WebSocket API (TypeBox → JSON Schema) on `127.0.0.1:18789`. Three WS client classes: control-plane, nodes, WebChat. Also serves the HTTP Canvas (`/__openclaw__/canvas/`, `/a2ui/`).
- **Runtime:** the **pi-agent-core** library (`PiEmbeddedRunner`), multiple providers with per-agent failover.
- **Sessions:** `sessions.json` index + append-only JSONL transcripts. DM isolation via `dmScope` (`main`, `per-peer`, `per-channel-peer` recommended...). Daily reset at 4:00, optional idle reset, manual reset; system turns do not extend freshness.
- **Memory:** Markdown in the workspace: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `MEMORY.md` (auto-injected, truncated to a budget), daily notes `memory/YYYY-MM-DD.md` (today+yesterday in context; the rest via hybrid `memory_search`). **Memory flush** before compaction (a silent turn that persists anything unsaved). Optional **dreaming**: background consolidation, tracked in `DREAMS.md`.
- **Heartbeat:** default cron **30 minutes**: reads `HEARTBEAT.md`, reasoning loop, decides whether to contact the user. Plus config-driven crons and webhooks.
- **Skills/plugins:** `SKILL.md` in `skills/<skill>/`, selective per-turn injection; ClawHub registry. Separate allow/deny lists for tools vs skills.
- **Multi-agent:** **isolated** agents within the same gateway (each with its own workspace, auth, model registry, session store). Deterministic routing via bindings. Inter-agent communication via `sessions_*` tools. Docker sandbox and per-agent tool allowlist.
- **Generative UI:** the **A2UI** protocol: declarative HTML (`a2ui-component`, `a2ui-action`, no arbitrary JS) served by the Canvas.

## Comparative note

Convergences (→ "safe" choices to inherit): a single multi-channel gateway daemon, memory in Markdown files, skills discovered at runtime, cron/heartbeat. Divergences: session storage (SQLite+FTS5 vs JSONL), multi-agency (delegation vs multi-persona with bindings), model routing (custom abstraction vs pi-agent-core).

**Implication for us:** both are chat-first; OpenClaw's Canvas/A2UI is a rich per-session _response_, not a _state_ that lives on. Our space is the persistent Home.
