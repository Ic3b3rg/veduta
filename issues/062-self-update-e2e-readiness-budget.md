# 062 — Make the self-update rollback E2E use the production readiness budget

## Verified bug

The staged self-update rollback journey has intermittently timed out on slow CI runners while the
same commit passed before and after. Its health predicate waits five minutes even though the
production updater allows a ten-minute readiness budget. Failure output is also obscured when the
captured self-check reason begins with Node's experimental SQLite warning instead of the relevant
health failure.

## Desired behavior

The E2E should derive its wait from the same readiness contract as production, while still failing
within a bounded time when recovery is genuinely stuck. Captured rollback reasons should lead with
the actionable self-check failure and retain useful diagnostics without unrelated warning noise.

## Acceptance criteria

- [ ] The rollback journey uses the production readiness budget or one shared exported contract,
      rather than an independently shorter timeout.
- [ ] A deterministic slow-start fixture completes within that budget and would fail under the old
      five-minute predicate.
- [ ] A genuinely stuck staged apply still times out with a clear phase and last-known state.
- [ ] Experimental runtime warnings do not prefix the user-visible self-check reason.
- [ ] The focused self-update E2E and update transaction tests pass repeatedly.
- [ ] `pnpm check` passes.

## Out of scope

- Masking arbitrary CI failures with an unbounded timeout.
- Changing the production readiness duration without separate evidence.
- Suppressing useful daemon errors or update audit records.

## Blocked by

None — can start immediately.
