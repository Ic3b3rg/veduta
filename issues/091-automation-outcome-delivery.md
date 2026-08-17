# 091 — Deliver Automation outcomes without flooding global chat and Space context

## Context

A generic recurring Automation currently turns every due occurrence into a `Scheduled briefing:`
system notice. The Gateway broadcasts that notice as an unscoped assistant `chat.message`, while
the occurrence and notification are also recorded in the owning Space's Event log. A frequent
Automation can therefore interleave with an unrelated active conversation and crowd the bounded
recent-event context with repeated briefing text even when nothing meaningful changed.

This is the behavior implemented by the original Scheduler and notification work, so changing the
delivery contract is an enhancement rather than a local regression.

## Goal

Automation attention is proportional to the outcome, not to the polling frequency:

- a routine or unchanged occurrence is silent in conversational chat;
- a changed, actionable, failed, or approval-required outcome is surfaced once in the owning
  Space through an explicit delivery policy;
- Automation activity remains inspectable without replaying raw recurring briefings into the
  Agent's bounded conversational context;
- a Space-owned Automation never emits an unscoped notice into every connected chat.

## Decisions required before implementation

- Define the durable outcome taxonomy and which outcomes map to Activity, badge, chat, or push.
- Decide whether routine occurrence events remain in the Event log but are excluded or compacted
  during context assembly, or are represented by a separate retained run history.
- Define deduplication, coalescing, reconnection, and repeated-error behavior.
- Define how a user opens the latest outcome and history from the Automations Surface.

## Preliminary acceptance boundary

- [ ] A no-change occurrence creates no assistant chat message and consumes no notification
      budget.
- [ ] A Space-owned outcome is never broadcast as a global, unscoped chat message.
- [ ] Repeated equivalent outcomes are coalesced according to one documented policy.
- [ ] The owning Space retains an auditable, bounded view of meaningful Automation activity.
- [ ] Existing trust origins, approval behavior, notification budgets, and fast-path Event-log
      guarantees remain intact.

## Related work

- [Issue 011](011-scheduler-timer-job.md) introduced visible timers and recurring Automations.
- [Issue 018](018-push-notifications.md) introduced notification discipline.
- [Issue 086](086-automation-worker-external-event-traces.md) covers tracing Automation and Worker
  work, not product delivery policy.
- [Issue 092](092-recurring-external-monitoring.md) depends on the policy established here.

## Out of scope

- Enabling provider-native web search or other provider-native tools.
- Implementing external URL fetching or article summarization.
- Changing ordinary user-turn serialization.

## Blocked by

None.
