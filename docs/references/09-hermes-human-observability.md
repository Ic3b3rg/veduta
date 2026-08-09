# Research 09 — Human observability in Hermes Agent

> Conducted on 2026-08-05 against the official Hermes Agent documentation and
> [NousResearch/hermes-agent at `64646dd`](https://github.com/NousResearch/hermes-agent/commit/64646dda56fe7e446804320280734679633b126d).
> Scope: what a normal user can inspect while Hermes works and afterwards. This is product
> observability, not model interpretability.

## Finding

Hermes is broadly observable, but not through one canonical audit trail. It combines live tool
progress, durable session transcripts, operational logs, status pages, usage estimates,
approvals, a learning timeline, file checkpoints, and support diagnostics. Its strongest human
evidence is the combination of **tool arguments and results, session transcripts, file diffs,
current state, and approval decisions**.

What Hermes does not document is a single append-only record that links, in order, the user's
request, the chosen model, every attempted action, approval, verified external effect, state
mutation, and final response. The available evidence is useful but fragmented across several
surfaces.

## What the user can inspect

| Question                              | Hermes surface                                                       | Important limitation                                                |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| What is it doing now?                 | CLI/TUI/Desktop/Web Chat stream tool activity and status             | Detail depends on display mode and channel                          |
| What happened in a conversation?      | Searchable, resumable session transcript with tool calls and results | It is a transcript, not an effect-verification ledger               |
| Which model and how much usage?       | Status bar, `/usage`, `/insights`, Web Analytics                     | Local cost totals are explicitly not billing truth                  |
| Is the installation healthy?          | Status, Channels, Cron, System, and Logs pages                       | Operational logs are separate from session evidence                 |
| What did it learn or change?          | Learning Journey, notifications, skill diffs, file checkpoints       | Several write gates and checkpoints are off by default              |
| Why was an action blocked or allowed? | Approval prompt and stored tool result                               | There is no complete decision audit for every action                |
| How can a failure be reported?        | `doctor`, `dump`, `debug share`, and Web System operations           | A support bundle is diagnostic evidence, not a product event record |

## Live work: clear on rich clients, quiet on Telegram

The classic CLI shows an animated API-call state and a live tool stream containing tool names,
command or path previews, and elapsed time. `/verbose` cycles through `off`, `new`, `all`, and
`verbose`. The TUI adds explicit `thinking` / `running` / `ready` state, live timers, expandable
thinking and tool sections, and an `/agents` view with per-branch token, cost, file, and turn
details. Hermes Desktop exposes streaming responses, live tool activity, structured tool-call
summaries, and context-window composition. The Web Dashboard's Chat page embeds the actual TUI,
including tool cards and approval prompts.
([CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli),
[TUI](https://hermes-agent.nousresearch.com/docs/user-guide/tui),
[Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop),
[Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard))

Telegram deliberately ships quieter. Per-tool progress is off by default, while natural
mid-turn assistant commentary and one edit-in-place long-running heartbeat remain on. A user can
opt into `new`, `all`, or `verbose`; `log` writes each tool call to a secret-redacted rotating
`~/.hermes/logs/tool_calls.log` without filling the chat.
([Messaging Gateway](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/))

This explains why Hermes can feel simple through Telegram while still retaining inspection
surfaces elsewhere: the default mobile experience reports that work is progressing without
showing the entire tool stream.

## Durable sessions and transcripts

Every CLI, messenger, cron, API, and other conversation is stored in SQLite with its source,
model configuration, system-prompt snapshot, full role-aware messages, tool calls and results,
token counts, and timestamps. Users can search, resume, archive, prune, and export sessions.
Exports include machine-readable JSONL, human-readable Markdown or HTML, and trace formats, with
an explicit secret-redaction option.
([Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/sessions/))

The Web Dashboard separates human chats from automation noise, marks live sessions, supports
full-text search, expands the full transcript by role, and renders each tool name and JSON
arguments in a collapsible block. It can export a complete session as JSON.
([Web Dashboard — Sessions](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#sessions))

This is strong retrospective evidence of what Hermes asked tools to do and what tools returned.
It does not by itself prove that a reported external effect occurred: that depends on the tool
result and any later verification the Agent performed.

## Model, token, context, and cost visibility

The CLI status bar shows the active model, context use, estimated session cost, compression
count, background-task count, session duration, and a persistent YOLO warning. `/usage` adds an
input/output cost breakdown and, where a provider supports it, live account limits. `/context`
breaks the model window down by system prompt, tool definitions, rules, skills, `MEMORY.md` /
`USER.md`, and conversation. `/insights` and the Web Analytics page aggregate sessions, tokens,
cache hits, daily activity, and per-model cost.
([CLI](https://hermes-agent.nousresearch.com/docs/user-guide/cli),
[slash commands](https://hermes-agent.nousresearch.com/docs/reference/slash-commands),
[Web Dashboard — Analytics](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#analytics))

The caveat is material: current Hermes main keeps Web token analytics **off by default** and
labels them a local lower-bound estimate. They exclude auxiliary calls, retries, fallbacks, and
cache writes, so the number may be far below the provider bill.
([current configuration reference](https://github.com/NousResearch/hermes-agent/blob/64646dda56fe7e446804320280734679633b126d/website/docs/user-guide/configuration.md#L2358-L2383))

## Operational state, automations, and logs

The Web Status page refreshes every five seconds and shows the Hermes version, Gateway PID and
state, connected platforms, active sessions, and recent session previews. Channels report
configured, enabled, and connected separately, offer a connection test, and can restart the
Gateway. Cron jobs show enabled/paused/error state, destination, last and next run, and support a
manual trigger. The System page adds host utilization, Gateway and skill-curator state, active
provider/tool routing, update state, and background maintenance actions.
([Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard))

Hermes keeps rotating `agent`, `errors`, `gateway`, `gui`, and `desktop` logs. The CLI can follow
and filter them by severity, session, time, and component; `agent.log` covers API calls, tool
dispatch, and session lifecycle. The Web Logs page provides a color-coded five-second tail over
agent, error, and Gateway logs.
([CLI commands — Logs](https://hermes-agent.nousresearch.com/docs/reference/cli-commands#hermes-logs),
[Web Dashboard — Logs](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#logs))

These are operational logs, not an immutable semantic account of every user-visible effect.

## Learning, configuration, file effects, and approvals

Hermes makes its learned state unusually visible. The Learning Journey plots saved skills and
`MEMORY.md` / `USER.md` entries chronologically and allows a user to inspect, edit, or delete a
node. Background learning emits `Memory updated` by default; verbose notifications include a
compact preview. Memory writes can be staged for `/memory approve` or `/memory reject`, and skill
writes can expose a full diff before approval. Both write-approval gates are **off by default**.
([Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/))

The Web Config page shows and edits the current configuration, redacts secrets, and supports
import/export. No documented user surface was found for a general append-only revision trail of
configuration mutations, or for preserving every edit and deletion in the Learning Journey.
The documented Web authentication audit log covers login and session-verification events only.
([Web Dashboard — Config and authentication audit](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard))

For project files, optional checkpoints snapshot state before writes and destructive terminal
commands. `/rollback` lists checkpoints with change statistics, `/rollback diff` shows the actual
diff, and restore first captures a recovery point. Checkpoints are **off by default**.
([Checkpoints and rollback](https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback))

Dangerous commands show their exact text and let the user allow once, allow for the session,
allow permanently, or deny. Messaging channels receive an approve/deny prompt. Smart approval is
the default: an auxiliary model may approve low-risk matches, deny dangerous ones, and escalate
uncertain cases. `hermes approvals suggest` mines dangerous commands that actually executed after
approval, but only to propose allowlist entries; it is not a complete action audit.
([Security](https://hermes-agent.nousresearch.com/docs/user-guide/security/))

`hermes security audit` is also narrower than its name might suggest: it is an OSV.dev
supply-chain scan of the Python environment, plugin requirements, and pinned MCP packages, not an
audit of Agent decisions or effects.
([CLI commands — Security](https://hermes-agent.nousresearch.com/docs/reference/cli-commands#hermes-security))

## Diagnostics and support

`hermes doctor` performs interactive diagnostics and can attempt repairs. `hermes status --all
--deep` expands health checks. `hermes dump` produces a redacted, copy-pasteable setup summary.
`hermes debug share` packages system information, API-key presence, and recent Agent, Gateway,
Web, and Desktop logs; it redacts by default and can stay local, use a public paste service, or go
to private Nous diagnostics. The Web System page exposes the same broad operations with their
live action logs.
([CLI commands — diagnostics](https://hermes-agent.nousresearch.com/docs/reference/cli-commands#hermes-doctor),
[Web Dashboard — System](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#system))

## Reasoning is provider-dependent, not a universal audit record

Hermes does not have a blanket policy of hiding model reasoning. Current main defaults
`display.show_reasoning` to true, `/reasoning show|hide` controls it, and the TUI expands its
thinking section by default. The session database stores raw reasoning text **when the provider
exposes it**. Conversely, the Codex integration distinguishes visible commentary from private
reasoning, and providers that return no reasoning trace give Hermes nothing to display.
([current display configuration](https://github.com/NousResearch/hermes-agent/blob/64646dda56fe7e446804320280734679633b126d/website/docs/user-guide/configuration.md#L1634-L1654),
[TUI detail visibility](https://hermes-agent.nousresearch.com/docs/user-guide/tui#detail-visibility),
[session storage](https://github.com/NousResearch/hermes-agent/blob/64646dda56fe7e446804320280734679633b126d/website/docs/developer-guide/session-storage.md#L91-L121))

Therefore, Hermes may display and persist provider-emitted thinking, but it cannot provide a
universal or guaranteed-faithful chain of thought. Such text is not reliable evidence that an
effect happened. Tool inputs, tool results, subsequent verification, diffs, and durable state are
the stronger human-readable record.

## Implications for Veduta

Hermes validates four useful product patterns:

1. Keep normal chat quiet, but provide expandable live tool activity and a clear long-running
   heartbeat.
2. Preserve complete, searchable transcripts with model, usage, tool calls, results, and export.
3. Separate Space activity from installation-wide health, logs, and support diagnostics.
4. Make learning and file mutations inspectable and reversible, with approval available before
   durable writes.

Veduta can go further by projecting its existing append-only Space Event log into one
human-readable activity surface that correlates a turn from request through tool use, Approval
card, result, Surface mutation, usage, and failure. Provider reasoning should not be the
accountability contract; concise Agent commentary plus verifiable actions and effects should be.
