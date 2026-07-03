# 023 — Local VPS profile for production-like testing

## Context

[ADR-0008](../docs/adr/0008-vps-passkey-byok.md) defines the VPS-first deployment profile. [ADR-0009](../docs/adr/0009-local-vps-profile.md) adds a local production-like profile so core flows can be rehearsed on a laptop without losing parity with the real user journey.

## Goal

A local environment that exercises the same core user flows as production closely enough to catch regressions before deploy.

## Tasks

- Local orchestration via Docker Compose or an equivalent local runner
- Passkey/WebAuthn login in the browser, not a dev token
- PWA, Gateway, persistent storage, and session state running together
- Mock LLM provider by default, real provider support through the same config shape
- Home, global chat, Surface updates, fast path, Event log, and persistence across restart
- Smoke and e2e coverage for the core flows, including first boot and a basic end-to-end user journey
- The scope stays living: add new core flows over time as the product grows

## Acceptance criteria

- A fresh local run can boot the full production-like stack and reach the Home
- A user can authenticate with passkey and complete a core flow that updates a Surface through chat
- Restarting the stack preserves the expected state
- Switching from mock to real provider uses configuration only, without changing the flow

## Dependencies

001, 005, 007, 009, 010
