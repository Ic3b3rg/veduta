# 012 — Event ingestion: webhooks, Gmail/Calendar, pre-filters

## Context
[ADR-0005](../docs/adr/0005-event-driven-proactivity.md) levels 0 and 2. Security in [SECURITY.md §3.5](../docs/SECURITY.md).

## Goal
The outside world comes in as structured events, filtered before touching any LLM.

## Tasks
- Generic webhook endpoint with per-source HMAC validation (Hermes pattern); local event queue (SQLite) with dedup and per-source rate limiting
- Gmail integration: OAuth + `users.watch` via Pub/Sub, automatic daily and monitored watch renewal; IMAP IDLE fallback for non-Google mailboxes
- Google Calendar integration: `events.watch` with TTL renewal
- **Deterministic pre-filters** (before any LLM): configurable rules (sender whitelist/blacklist, event types), optional embedding similarity against examples of "important things"; every discard logged with a reason
- Surviving events go to the quarantined reader (issue 013), never directly to the Agent

## Acceptance criteria
- A newsletter email is discarded by the pre-filter: zero LLM calls (assert on a counter)
- An email from a whitelisted sender reaches the Agent, structured, in < 30s from sending
- Webhook with invalid HMAC → 401 and a log entry, no event queued
- Expired Gmail watch → automatic renewal within the hour, with an alert if it fails 3 times

## Dependencies
004, 010
