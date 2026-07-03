# 018 — Web push and notification discipline

## Context
[ADR-0005](../docs/adr/0005-event-driven-proactivity.md): silent → badge → push; the bar is "would a good human assistant interrupt?".

## Goal
Reliable push without becoming a nuisance — where all personal agents fail.

## Tasks
- Web push (VAPID) from the daemon: per-device subscriptions, cleanup of expired ones; deep link to the relevant Surface
- Hierarchy enforced in code: silent update (the absolute default) → badge on the Space → push; a push requires an explicit justification from the Agent (logged)
- Per-Space interruption budget (configurable from the settings Surface); budget exceeded → degrade to badge
- Queueing of non-urgent notifications for quiet moments (configurable window, e.g. not before 8am, digest if >3 queued) — CHI 2025 evidence on timing
- iOS: guided onboarding to PWA installation (a prerequisite for push), with verification and an explained fallback

## Acceptance criteria
- A routine Surface update does NOT generate a push (assert)
- A missed deadline (timer, issue 011) generates a push with a deep link that opens the right Surface
- Once the Space's budget is exceeded, pushes degrade to badges and this is visible in the settings

## Dependencies
005, 009, 011
