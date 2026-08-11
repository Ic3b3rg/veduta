# 089 — Route Gateway operations through structured Runtime logging

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Complete the wide migration from ad-hoc first-party operational console output to the structured Runtime logger. Gateway lifecycle, chat, storage, scheduling, ingestion, notification, update, and adapter failures become human-readable in retained Runtime logs and journald while CLI output remains an explicit command-line interface.

## Acceptance criteria

- [ ] Non-CLI first-party operational messages use stable component, level, message, optional traceId, and allowlisted redacted detail instead of raw console arguments.
- [ ] Raw HTTP bodies, headers, provider envelopes, process environments, endpoint values, secret-bearing child stderr, and complete errors never enter Runtime records.
- [ ] Fatal exception and rejection monitoring records a final safe Runtime message without installing a handler that changes Node termination behavior.
- [ ] A Runtime file or live-delivery failure uses a bounded non-recursive emergency path while journald and the observed product operation continue where possible.
- [ ] Gateway readiness is recorded without exposing pairing or bootstrap material; production process output contains no setup URL or code while the Local VPS terminal handoff remains available.
- [ ] Existing CLI commands retain their user-facing stdout and stderr behavior and are not silently converted into Runtime records.
- [ ] Runtime records created inside a Trace carry its traceId and can be correlated from the console.
- [ ] Tests identify any remaining non-CLI ad-hoc operational console output.
- [ ] pnpm check passes.

## Blocked by

- #82 — requires the structured Runtime logger, retained sinks, and Runtime console.

## Delivery constraints

- Implement and verify this wide migration in an isolated Git worktree.
- Migrate call sites in green batches while the old console path remains available, then enforce the completed boundary.
- Preserve deliberately suppressed sensitive adapter output.
