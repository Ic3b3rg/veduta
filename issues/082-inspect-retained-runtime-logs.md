# 082 — Inspect retained Runtime logs from the hidden console

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Deliver the first end-to-end slice of the internal diagnostic console. The Gateway continuously writes structured, redacted Runtime logs to bounded local segments and journald. An authenticated user can open the hidden /app/trace route, inspect retained Runtime logs newest-first, load older segments progressively, and copy or download only the redacted records already loaded in memory. Realtime delivery is not part of this ticket.

## Acceptance criteria

- [ ] DEBUG, INFO, WARN, and ERROR records are structurally validated, redacted, field-denied, UTF-8 bounded, and visibly marked when detail is truncated before reaching any queue or sink.
- [ ] Runtime segments rotate at 5 MiB, retain at most ten segments, 50 MiB, and seven days, preserve the active segment, expose partial or missing data as an explicit gap, and use 0700 directories plus 0600 files.
- [ ] A Runtime file failure does not fail the observed Gateway operation; journald continues and the retained reader reports DEGRADED with a bounded gap.
- [ ] Authenticated, no-store read APIs return segment inventory and at most one retained 5 MiB segment without filesystem paths or credentials; unauthenticated requests reveal no diagnostics.
- [ ] The hidden /app/trace route respects the existing authentication and onboarding gates, is absent from ordinary navigation, opens no Home chat socket, shows every Runtime level without filters, and works on mobile.
- [ ] Copy and download contain only protocol-validated redacted records currently loaded in memory and are not persisted by the PWA.
- [ ] Retained Runtime records remain readable after a normal Gateway restart.
- [ ] pnpm check passes.

## Blocked by

None — can start immediately.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Preserve ADR-0017: diagnostics are non-canonical and fail open without weakening Event log, security audit, or session guarantees.
- Do not introduce OpenTelemetry, an external collector, commands, retry, restart, configuration, retention, clear, or delete controls.
