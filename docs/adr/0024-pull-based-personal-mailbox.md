# Personal Mailbox access is pull-based through passive provider adapters

> The pull-based access and persistence decisions remain accepted. The typed-adapter-only
> implementation below was refined by
> [ADR-0026](0026-skills-may-drive-general-tool-execution.md), which allows connector Skills to use
> native operations and external CLIs directly.

A personal mailbox is connected so the Agent can perform explicitly requested work; the
connection is not permission to watch, ingest, classify, or replicate the inbox. The earlier
event-ingestion design treated Gmail Watch and IMAP IDLE as ordinary push sources. That optimized
reaction latency but made background mailbox access an implicit consequence of setup, blurred the
boundary between a personal assistant and an email gateway, and left recurring query semantics to
connector defaults.

A **Mailbox connection** is therefore a passive, Gateway-wide authorization with a stable account
identity. Authorization may verify identity and declared capabilities, but provider message access
occurs only while serving either an explicit user request owned by one Space or a due occurrence of
an explicitly confirmed Automation. Connecting, booting, reconnecting, or running general Gateway
maintenance causes no mailbox scan, import, read, summary, Surface change, notification, or mail
Event. The same connection may be referenced from multiple Spaces, but each request, Automation,
result, Event, and Surface belongs to exactly one Space.

The Agent sees one provider-neutral, typed mail contract. Gmail uses the native Gmail API and
OAuth. Generic IMAP/SMTP uses an exactly pinned, Veduta-managed Himalaya binary behind a constrained
adapter; Himalaya owns protocol details but never becomes an Agent-facing shell. Credentials remain
in Veduta's vault, provider capabilities stay explicit, and Microsoft 365 is not claimed until a
verified modern OAuth or Graph path exists. The adapters may expose only the v1 operations: bounded
search and summary, transient explicit open, and approved threaded reply.

Every operation resolves a **Mailbox scope** before message access: account set, folders or labels
and provider query, time window, read-state filter, result bound, and permitted mutations. A
confirmed Automation persists exactly trigger → operation → result. “New since this Automation”
initializes its watermark at confirmation with no implicit backlog; an explicit window such as
“today's unread mail” is evaluated literally at the occurrence. No default newest-N query, inbox
scan, hidden cursor, or Skill may widen that contract.

Search, summary, and Automation reads preserve provider unread state. Only an **Explicit mail
read** marks the selected message read, and reply-context retrieval remains non-mutating. Raw
message content and attachments are Untrusted and transient: only bounded, schema-validated Mail
summaries and provider identities may persist. A reply is an editable L1 Approval card and remains
in the provider thread; no mail-derived turn bypasses Approval. Archive, delete, move, labels,
stars, spam handling, folders, attachments, new-message composition, and autonomous replies are
outside v1.

Interactive results produce concise text plus a query-labelled Mailbox Surface. A recurring
Automation updates the same linked Surface and uses the Space-owned outcome contract: unchanged is
freshness only; meaningful change, failure, and recovery may create an In-app notification, never
an unsolicited assistant message, badge, or browser push.

This decision refines [ADR-0005](0005-event-driven-proactivity.md): events-first still governs
Calendar watches, explicit webhooks, timers, and sources whose continuous delivery the user
actually authorized. It supersedes [ADR-0023](0023-imap-idle-client.md) for personal mail; the
accepted ImapFlow implementation remains historical evidence and is removed after compatible
legacy configurations can migrate. A dedicated mailbox used as a conversational Bridge is a
different product capability and does not weaken this boundary.

Evidence and alternatives are recorded in
[research 14](../references/14-hermes-mailbox-behavior.md) and
[research 15](../references/15-hermes-mail-provider-connections.md). The implementation sequence is
tracked by issues #120 through #127.

Status: accepted; the Agent-facing execution boundary is refined by
[ADR-0026](0026-skills-may-drive-general-tool-execution.md)
