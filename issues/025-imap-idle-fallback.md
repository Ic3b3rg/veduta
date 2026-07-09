# 025 — IMAP IDLE fallback for non-Google mailboxes

## Context

Issue [012](./012-event-ingestion.md) shipped event ingestion with the generic HMAC webhook
and the Gmail/Calendar push integrations, and deliberately descoped the IMAP IDLE fallback:
a raw IMAP client (TLS socket, protocol state machine, IDLE keepalive) is a self-contained
piece of work with no dependency in the repo yet. Until this lands, non-Google mailboxes
reach the daemon through the generic webhook (`/api/ingest/:source`, `hmac` verification)
via any mail-forwarding bridge.

## Goal

Non-Google mailboxes push mail events with the same latency and discipline as Gmail watch
(ADR-0005 level 0), with no polling.

## Tasks

- Minimal IMAP client (or a vetted, lightweight dependency — decide with an ADR note):
  TLS connect, LOGIN/AUTHENTICATE, SELECT INBOX, IDLE with keepalive re-issue before the
  29-minute server timeout, reconnect with backoff
- Credentials as `secret://` references, resolved at connect time, never logged
- On new-message notification: fetch envelope headers only (From, Subject,
  List-Unsubscribe, Precedence) and emit a normalized `ExternalEvent`
  (`external-event.ts`) into the existing pipeline (queue → pre-filters → reader seam)
- Connection health surfaces like watch renewal: consecutive-failure counter, alert after
  3 failures via the system notice (reuse the `watch-renewal.ts` alert discipline)
- Tests against a scripted fake IMAP server (no network)

## Acceptance criteria

- A new message on a non-Google mailbox reaches the pre-filter as a structured event in
  < 60s without any polling loop
- A dropped connection reconnects with backoff; 3 consecutive failures alert the user once
- Credentials never appear in logs, the Event log, or LLM context

## Dependencies

012
