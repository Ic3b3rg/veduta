# 086 — Trace Automation, Worker, and external-event work

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Give durable asynchronous work its own meaningful Activity. Each claimed Automation occurrence, Worker run, and accepted external event becomes a new root Trace. Work spawned from another operation carries only parentTraceId correlation and never keeps an in-memory request context alive indefinitely.

## Acceptance criteria

- [ ] A successfully claimed Automation occurrence starts one root Trace containing its Automation identifier, Space, scheduled instant, outcome, and redacted error when present.
- [ ] A Worker starts a distinct root Trace with its Worker, session, and Space scope; when spawned inside another Trace it records parentTraceId without retaining parent step state.
- [ ] Accepted external events and boot-time redelivery start roots using safe source and queue identifiers without copying raw webhook, mail, or provider payloads.
- [ ] Cancellation, retry, recovery, budget, single-flight, claim, and settlement behavior remains unchanged.
- [ ] A diagnostics failure or observer failure cannot fail the Automation, Worker, or ingestion operation being observed.
- [ ] Activity search and detail make each background failure attributable to its exact root and component.
- [ ] Parent-child correlation remains truthful after restart: recovered durable work may be unparented when no initiating Trace was retained.
- [ ] pnpm check passes.

## Blocked by

- #83 — requires the retained root-Trace lifecycle, Activity reader, and inspector.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Record identifiers and outcomes, not complete external content or model context.
- Preserve existing Automation, Worker, Event log, and quarantined-reader guarantees.
