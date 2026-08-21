# 135 — Pull-based personal Mailbox roadmap

## Goal

Coordinate the migration from ambient personal-mail ingestion to passive, explicitly scoped
Mailbox work owned by a Space. Connecting a mailbox must not read, import, classify, or mutate mail
by itself; provider access happens only for an explicit user request or a due occurrence of a
confirmed Automation.

## Child slices

- #120 quiesces ambient Gmail Watch and any legacy mail-ingestion activation already present on
  `main`.
- #121 adds the passive native Gmail Mailbox connection.
- #122 adds Gmail Mailbox search and summary through a first-party Skill.
- #123 adds the Himalaya Skill and Veduta-owned general execution boundary.
- #124 adds transient explicit mail read and provider read-state mutation.
- #125 adds editable, approved, provider-threaded reply.
- #126 adds exact-scope Mailbox Automations.
- #127 removes superseded Gmail Watch code and reconciles the archived, never-merged IMAP IDLE
  implementation.

The explicit blocker graph on the child issues controls implementation order. This parent is a
roadmap and is not an additional implementation slice.

## Historical recovery

The pre-realignment planning checkpoint is preserved on
[`wip/pre-main-realignment-20260821`](https://github.com/Ic3b3rg/veduta/tree/wip/pre-main-realignment-20260821).
The issue #25 implementation was completed off `main` and remains recoverable on
[`archive/025-imap-idle-fallback`](https://github.com/Ic3b3rg/veduta/tree/archive/025-imap-idle-fallback);
it is design and conflict-resolution input for #123/#127, not shipped behavior.

## Repository specification

[`issues/135-pull-based-personal-mailbox.md`](https://github.com/Ic3b3rg/veduta/blob/main/issues/135-pull-based-personal-mailbox.md)
