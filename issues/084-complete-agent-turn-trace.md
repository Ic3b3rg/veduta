# 084 — Explain a complete Agent turn inside one Trace

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Enrich a retained chat Trace with the meaningful work performed by Veduta's Agent. Model attempts and failover, tool execution, committed Surface mutations, and committed Event log appends appear as correlated steps under the same traceId. The Activity inspector identifies the exact failing or recovered step without treating optional provider metadata as verified effects.

## Acceptance criteria

- [ ] One chat fixture shows model, tool, Surface, and Event log steps under the same traceId with correct parent-child ordering.
- [ ] A failed primary model attempt followed by successful failover remains an ERROR step inside a COMPLETED root Trace; exhausted or non-retryable failure ends the root as ERROR.
- [ ] Tool input and result detail is redacted and bounded, tool errors identify the correct step, and existing taint, approval, effect, sequencing, and no-failover-after-tool guarantees remain unchanged.
- [ ] Surface and Event log steps are emitted only after the corresponding mutation commits; observer failure cannot change an already committed product operation.
- [ ] Provider cost, token usage, and provider-emitted reasoning appear only when present on their originating model step; missing values remain absent and reasoning is never synthesized.
- [ ] Trace records reference persisted session-entry identifiers without copying transcript content.
- [ ] Streamed text token deltas and ordinary internal functions create no Activity noise.
- [ ] The Activity inspector renders model attempts, retry or failover, tools, Surface changes, Event log appends, errors, and optional provider detail only where observed.
- [ ] pnpm check passes.

## Blocked by

- #83 — requires the retained Activity path, correlation context, search, and inspector.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Keep all model execution behind Veduta's AgentRunner boundary.
- Preserve existing Event log, session, trust, and Surface-validation guarantees.
