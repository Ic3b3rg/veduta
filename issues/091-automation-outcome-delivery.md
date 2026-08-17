# 091 — Deliver Automation outcomes inside their owning Space

## Context

A generic recurring Automation currently turns every due occurrence into a `Scheduled briefing:`
system notice. The Gateway broadcasts that notice as an unscoped assistant `chat.message`, while
the occurrence and notification also enter the owning Space's Event log. Frequent Automations can
therefore interleave with unrelated conversation and crowd bounded context even when nothing
meaningful changed.

The existing Notification Center exposes only Space attention badges and browser push. Neither is
the durable, navigable In-app notification requested for dashboard outcomes. This ticket must add
that product concept without overloading diagnostic Activity or Pending decisions.

## Resolved contract

Use one explicit outcome taxonomy for recurring dashboard work:

- `unchanged` advances `lastCheckedAt`, appends compact provenance, and creates no outcome,
  notification, chat message, badge, or push;
- `changed` atomically updates the linked Surface and creates or coalesces one In-app notification
  inside the owning Space;
- `failed` retains the last valid Surface content, records `lastCheckedAt`, `lastSuccessfulAt`, and
  a safe error, and creates or coalesces one failure notification after the occurrence exhausts
  its retry policy;
- `recovered` clears the visible error, updates the Surface, and creates one recovery notification;
- `decision-required` delegates to the existing Pending-decision service and its owning workflow.

The durable rationale is recorded in
[ADR-0021](../docs/adr/0021-space-owned-automation-outcomes.md).

## In-app notification contract

- A notification is durable, protocol-validated, scoped to exactly one Space, and carries a
  same-origin deep link to the affected Surface.
- The Space route renders notifications above its Surface groups with explicit `Open Surface` and
  `Dismiss` actions. Neither action is hidden behind the notification text alone, and both are
  keyboard accessible.
- Equivalent unread outcomes from the same Automation and target Surface update one notification's
  timestamp and occurrence count. Opening or dismissing it closes that coalescing window; the next
  meaningful outcome creates a new notification.
- Equivalent repeated failures coalesce. Recovery settles the failure state and creates or
  coalesces a recovery notification.
- Creation, coalescing, opening, and dismissal are confirmed Gateway mutations with Space Event
  entries. Restart, reconnect, and stale HTTP/realtime races cannot resurrect older state.
- In-app notifications never increment Space attention, consume browser-push budget, emit browser
  push, or create assistant chat messages.

## Surface and history contract

- Every linked Automation Surface exposes the latest structured outcome, `lastCheckedAt`,
  `lastSuccessfulAt`, and current safe error state.
- The Automations Surface exposes a bounded, expandable Automation run history containing only
  meaningful changes, failures, and recoveries. Routine checks are represented by freshness.
- The append-only Event log remains complete and is never rewritten. Routine occurrence events and
  notification bookkeeping are excluded from default conversational context while remaining
  available through explicit retrieval and diagnostics.
- One-shot deadline reminders retain the existing escalation behavior from issues #11 and #18.

## Acceptance criteria

- [ ] A no-change recurring occurrence updates freshness and appends compact provenance without an
      assistant chat message, In-app notification, badge, push, or reasoning call when deterministic
      checks are sufficient.
- [ ] A meaningful outcome updates one schema-valid Surface and creates one durable In-app
      notification in the owning Space with an accessible `Open Surface` action.
- [ ] Multiple equivalent outcomes before read/dismissal coalesce into one notification; the next
      outcome after read/dismissal creates a new one.
- [ ] Failure, repeated failure, and recovery preserve last-valid content and follow the resolved
      error and notification policy.
- [ ] A Space-owned Automation never emits an unscoped `chat.message` or exposes its notification in
      another Space.
- [ ] Automation run history is bounded and excludes routine checks, while the append-only Event log
      remains complete and default context stays free of raw recurring briefings.
- [ ] Protocol, daemon, PWA, restart/reconnect, and browser tests cover navigation, dismissal,
      coalescing, freshness, races, and accessibility.
- [ ] `pnpm check` and the relevant browser E2E job pass.

## Out of scope

- Changing one-shot reminder escalation.
- Enabling browser push for recurring dashboard outcomes.
- Reusing diagnostic Activity as user-facing history.
- Fetching or interpreting external content; issue #92 owns that work.

## Blocked by

None — can start immediately.
