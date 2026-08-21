# Research 14 — Mailbox behavior in Hermes Agent

> Conducted on 2026-08-19 against the official Hermes Agent documentation and
> [NousResearch/hermes-agent at `13ce0c5`](https://github.com/NousResearch/hermes-agent/commit/13ce0c5c675e843af70d19c9e5144249cd51c8d1).
> Scope: on-demand mailbox access, scheduled checks, watching/polling, read state,
> threads/replies, and output destinations. Statements labelled **absence** or
> **inference** are not documented product guarantees.

## Finding

Hermes has two separate email models that should not be conflated:

1. **Operating a mailbox** uses the Himalaya or Google Workspace skills. This path is
   pull-based: Hermes searches or reads only while handling a user request or an explicitly
   scheduled cron run.
2. **Using email as a chat channel** uses the Email gateway adapter with a dedicated agent
   account. Once enabled, it polls continuously for new mail and replies over SMTP in the same
   email thread.

The first is the relevant comparison for Veduta's Mailbox assistant. It supports the current
Veduta direction—no default background sync, explicit operations, and opt-in Automations—but it
does **not** settle Veduta's default result window, first-run boundary, or persistent-Surface UX.

## Personal mailbox: pull on request

Hermes explicitly describes its Himalaya mailbox path as pull-based: "the agent only sees mail
when it looks." A normal chat request can cause the Agent to list, search, or read messages via
the external `himalaya` CLI; periodic access is added separately with cron.
([official guide](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/guides/agent-email-address.md#L63-L77),
[Himalaya skill](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/SKILL.md#L102-L155))

The higher-level inbox-triage skill requires the Agent to establish the account, folders or
labels, half-open time window, unread/all choice, maximum thread count, and mutation boundary.
It then searches within that bound and reads complete relevant threads. Its stated output is a
prioritized textual report: needs attention, replies to approve, other actions, waiting items,
reference/noise, and coverage failures.
([triage scope and retrieval](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L28-L37),
[output shape](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L65-L87))

For Gmail, the Google Workspace helper exposes an explicit search query, a full-message read,
send, reply, and label modification. Search defaults to at most 10 **messages** and returns a
`threadId` on each result; its parser does not provide a query-less "show mail" operation.
([skill commands and result shape](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/SKILL.md#L176-L200),
[search implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/google_api.py#L214-L314),
[required query and default limit](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/google_api.py#L1058-L1069))

**Absence:** Hermes does not document a universal product rule for a bare request such as
"show me my emails." The Gmail helper's 10-message cap and Himalaya's 20-item pagination example
are connector mechanics, not a documented newest-first UX with "show more." The triage skill
instead says the scope and bound must be resolved explicitly.

## Scheduled and recurring checks

Hermes cron jobs may be one-shot or recurring, can load mailbox skills, and can be created in
natural language. Each due run starts a fresh isolated Agent session, loads the stored prompt
and optional skills, executes it, and delivers the final response.
([cron capabilities and creation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/cron.md#L7-L22),
[execution sequence](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/cron.md#L290-L315))

The official mailbox guide recommends a cron prompt that lists unread messages, summarizes
newsletters or receipts, alerts only when something needs attention, and does not reply to or
act on unsolicited mail. The in-repo `important-mail` blueprint likewise polls on a selected
interval, asks for messages "since the last run," applies user-supplied importance criteria, and
returns `[SILENT]` when nothing qualifies. Nothing is scheduled merely by connecting the mailbox;
the blueprint only becomes a job when the user selects it.
([mailbox cron recipe](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/guides/agent-email-address.md#L65-L84),
[important-mail blueprint](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/blueprint_catalog.py#L141-L170))

Run-to-run state is generic rather than mail-specific. Cron sessions normally start with no
memory of prior runs. An optional `continuity=true` injects the previous run's output so the Agent
can avoid repeating reported items. The scheduler also has a per-job durable notepad intended
for cursors and watermarks, but no cited mailbox blueprint configures one automatically.
([documented continuity](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/cron.md#L647-L663),
[notepad implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/notepad.py#L1-L20))

**Implementation finding:** the `important-mail` blueprint's generated job contains only its
prompt, schedule, name, delivery target, and attached skill. It does not enable continuity or
initialize a provider cursor. Therefore "since the last run" is an Agent instruction, not an
enforced mailbox boundary, and the first-run boundary is unspecified.
([blueprint materialization](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/blueprint_catalog.py#L747-L799))

## Read and unread state

On the Google Workspace path, search and full-message read call Gmail `messages.list` and
`messages.get`; neither calls `messages.modify`. Marking a message read is a separate explicit
operation that removes the `UNREAD` label. Thus the current helper does not mark Gmail mail read
merely because Hermes searched or fetched it.
([read-only calls](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/google_api.py#L214-L314),
[explicit label mutation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/google_api.py#L424-L456))

The Himalaya skill exposes `seen` as an explicit flag that can be added or removed. It does not
state whether the external CLI's `message read` command itself changes provider state, so no
stronger Hermes guarantee can be inferred for that connector.
([Himalaya flag commands](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/himalaya/SKILL.md#L234-L246))

The triage workflow defaults to read and draft rather than send or delete, requires proposed
mutations to be shown as an approval batch, and verifies approved changes against the provider.
([approval and verification](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L53-L63))

## Threads and replies

Hermes's triage policy treats a thread as the unit of understanding: it asks the connector to
retrieve the complete relevant thread before classifying or drafting. The bundled Gmail helper,
however, searches individual messages. Its reply operation fetches the selected message, sets
`In-Reply-To` and `References`, and sends with the original Gmail `threadId`, so the provider
places the reply in the existing thread.
([thread-aware triage](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L34-L59),
[Gmail reply implementation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/productivity/google-workspace/scripts/google_api.py#L361-L420))

**Absence:** no official source examined defines an inbox UI with one row per provider thread.
Thread identity is connector data and reply context, not a prescribed presentation model.

## Where results appear

Interactive mailbox work returns through the conversation as the Agent's normal response. Cron
persists every job output under `~/.hermes/cron/output/{job_id}/{timestamp}.md` and delivers the
final response to the configured target: the origin chat, local files only, email, or another
connected channel. `[SILENT]` suppresses the message while retaining the local output. By default
a delivered cron result is fire-and-forget; continuation is opt-in and, on thread-capable chat
platforms, creates a fresh thread for each run.
([delivery targets](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/cron.md#L346-L377),
[continuable delivery and silence](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/cron.md#L419-L520),
[output storage](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/cron.md#L938-L950))

**Absence:** Hermes does not document a persistent, reusable mailbox result Surface. Its durable
artifact is the per-run Markdown output/history; its user-facing result is a chat or channel
delivery. Veduta's Automation-linked Surface is therefore a deliberate product difference, not a
Hermes pattern.

## The separate Email gateway adapter

The Email gateway is explicitly not the mailbox-management skill. It turns a dedicated email
account into a Hermes chat address. When started, it establishes an internal baseline of existing
message UIDs, polls IMAP `UNSEEN` every 15 seconds by default, converts each new allowed email to
a chat event, and replies by SMTP with `In-Reply-To` and `References` headers.
([official distinction](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L7-L20),
[documented polling and replies](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/messaging/email.md#L86-L123),
[polling source](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/email/adapter.py#L813-L930),
[reply source](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/email/adapter.py#L1158-L1199))

There is a documentation/source nuance around "seen." The guide says startup marks every existing
message seen. Current source instead performs `SEARCH ALL` and records those UIDs in an in-memory
set so they are skipped; it issues no provider `STORE ... \\Seen` command in that path. Later it
searches `UNSEEN` and fetches new messages with `RFC822`. The source therefore proves Hermes's
internal processed/not-processed boundary, but not an explicit provider-flag mutation at startup.
([startup baseline source](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/email/adapter.py#L672-L745),
[fetch source](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/platforms/email/adapter.py#L851-L930))

This always-on adapter is useful when email itself is the conversation transport. It is not a
precedent for automatically watching a user's personal mailbox after connection.

## Implications for Veduta triage

1. **Keep the personal Mailbox pull-based.** Hermes's closest comparable feature reads only for
   a direct request or an accepted schedule.
2. **Do not copy the gateway's polling semantics.** That system serves a dedicated agent address
   as a chat channel, not personal-mailbox assistance.
3. **Preserve unread state by default.** This agrees with Hermes's Gmail helper, where fetching
   and label mutation are separate operations.
4. **Make first-run and incremental semantics explicit in Veduta.** Hermes's built-in mail monitor
   says "since the last run" but does not encode a first-run watermark or mailbox cursor. Veduta
   should bind `trigger → operation → output` to the user's confirmed instruction and store the
   required Automation state explicitly.
5. **Treat "latest N + show more" as a Veduta decision.** Hermes has bounded connector commands,
   but no documented universal behavior for an underspecified "show my email" request.
6. **Keep the linked Surface as a Veduta differentiator.** Hermes persists per-run Markdown and
   delivers messages; it does not maintain one reusable structured mailbox result surface.
