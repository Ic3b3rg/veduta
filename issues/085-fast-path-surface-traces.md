# 085 — Trace fast-path Surface interactions

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Make each authenticated fast-path Surface interaction a root Trace whose meaningful steps reflect only committed Surface and Event log changes. A user inspecting Activity can distinguish a successful mutation, an idempotent duplicate, and a failed action without changing the existing HTTP behavior or the fast path's Event log guarantee.

## Acceptance criteria

- [ ] Declared fast-path actions and Pin interactions start Gateway-owned root Traces with safe summaries and Gateway-resolved Space scope.
- [ ] Successful actions show their committed Surface mutation and matching Event log append under the same traceId.
- [ ] Idempotent duplicates do not fabricate a second mutation or Event log step.
- [ ] Validation and domain errors preserve their existing response status and body while the Trace records the actual terminal outcome.
- [ ] A diagnostic observer failure cannot fail, roll back, or alter a committed Surface or Event log mutation.
- [ ] Activity lets the user identify the exact fast-path step that completed or failed without storing the full request payload.
- [ ] Existing Pin, Tree proposal, Surface validation, and Event log guarantees remain unchanged.
- [ ] pnpm check passes.

## Blocked by

- #84 — reuses the committed Surface and Event log observation seams introduced for complete Agent turns.
- #156 — observes only delivered Surface commits after cross-store recovery completes.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Every actual fast-path mutation must still append to the Space's canonical Event log.
- Trace recording remains non-canonical and fail open.
