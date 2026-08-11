# 087 — Trace approvals, notifications, and updates

## Parent

#81 — Internal trace console: locate runtime problems and errors

## What to build

Expose the meaningful lifecycle of approvals, notification delivery, and verified updates in Activity. Pending decisions appear under their initiating Trace when one exists; later resolution, outbox delivery, and detached update work use truthful root Traces that survive process boundaries.

## Acceptance criteria

- [ ] Approval creation records a pending step with safe approval, effect, tool, and trust-level identifiers.
- [ ] Approve, reject, expiry, and resolution failure create a distinct root lifecycle that identifies the decision without treating approval as proof that an external effect succeeded.
- [ ] Notification decisions are visible under the current Trace, while each outbox delivery attempt is a root that records channel, outcome, retry, and only an irreversible endpoint hash.
- [ ] Update check and apply work records verified version and outcome without command output, feed bodies, process environment, or credentials.
- [ ] Restarted outbox or update recovery produces truthful detached roots rather than fabricated in-memory ancestry.
- [ ] Existing trust, effect verification, notification retry, and signed-update guarantees remain unchanged.
- [ ] Diagnostic failures do not change the observed approval, delivery, or update outcome.
- [ ] Activity identifies the exact failed approval, delivery, or update step.
- [ ] pnpm check passes.

## Blocked by

- #83 — requires the retained root-Trace lifecycle, Activity reader, and inspector.

## Delivery constraints

- Implement and verify this ticket in an isolated Git worktree.
- Preserve trust levels and Approval cards as canonical product behavior; Trace records are diagnostic only.
- Never retain notification endpoints, payload bodies, update environments, or secret material.
