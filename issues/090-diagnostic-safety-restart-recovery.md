# 090 — Prove diagnostic safety, restart retention, and hard-down recovery

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Close the internal diagnostic console with cross-sink security evidence, deterministic failure and retention tests, one authenticated browser journey, restart verification, and an exact SSH fallback for a Gateway that cannot start. This ticket introduces no second diagnostic service and does not close or rewrite the parent issue.

## Acceptance criteria

- [ ] Distinct sentinel API keys, OAuth tokens, Authorization values, cookies, session material, bootstrap codes, and nested sensitive fields are absent from Activity and Runtime JSONL, the disposable index, journald, REST, WebSocket, copy, and download output.
- [ ] Details beyond 64 KiB are visibly truncated and byte metadata is calculated only after redaction.
- [ ] Injected queue, file, index, live-delivery, partial-line, corruption, and rotated-cursor failures do not fail observed product work and produce an exact visible gap or DEGRADED state.
- [ ] Deterministic evidence proves Activity and Runtime size and age retention, oldest-complete-segment deletion, active-segment preservation, and 0700/0600 permissions.
- [ ] An authenticated Local VPS browser journey locates one chat Trace containing model, tool, Surface, and Event log steps, observes realtime opt-in behavior, and reads the same retained Trace and Runtime records after restart.
- [ ] Operations documentation gives exact production journald and retained Runtime-file commands plus the Local VPS equivalent.
- [ ] Documentation states that /app/trace cannot work while the Gateway is down and that no recovery sidecar, public endpoint, or second viewer exists.
- [ ] Evidence covers every acceptance criterion in #81 without marking or closing the parent issue automatically.
- [ ] pnpm check and the focused Local VPS browser E2E journey pass.

## Blocked by

- #84 — complete Agent-turn correlation.
- #85 — fast-path Trace coverage.
- #86 — Automation, Worker, and external-event coverage.
- #87 — approval, notification, and update coverage.
- #88 — authenticated opt-in realtime delivery.
- #89 — completed Runtime logging boundary.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Treat diagnostics as non-canonical, bounded, redacted, and fail open throughout the evidence.
- Do not add OpenTelemetry, external collectors, alerting, metrics, commands, a recovery service, or mutation controls.
