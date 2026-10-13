# Automation outcomes stay in their owning Space

Recurring work must not impersonate a conversation. A routine Automation occurrence advances
freshness and appends its compact provenance without producing an Automation outcome. A meaningful
change updates the linked Surface and creates one durable In-app notification, shown only inside
the owning Space and deep-linked to that Surface. It does not create an assistant chat message,
increment a Space attention badge, or send browser push.

Equivalent unread notifications from the same Automation coalesce by updating their timestamp and
count. Opening or dismissing one ends that coalescing window, so the next meaningful change creates
a new notification. An Automation failure retains the last valid Surface content and exposes the
last check, last successful update, and a safe error. Equivalent repeated failures coalesce; a
later recovery clears the error and creates one recovery notification.

The Automation Surface exposes those freshness fields plus a bounded, expandable Automation run
history containing meaningful changes and errors. Routine checks remain in the append-only Event
log as compact provenance but are excluded from default conversational context; neither raw
scheduled briefings nor notification-delivery bookkeeping is replayed into chat. A required user
choice delegates to the channel-neutral Pending-decision contract rather than masquerading as an
ordinary outcome.

This refines ADR-0005 without replacing its interruption hierarchy. An In-app notification is
durable product state and navigation, while a badge and browser push are escalating interruption
channels. One-shot deadline reminders retain their existing escalation policy; this decision
governs recurring dashboard outcomes.

The rejected alternatives are broadcasting every occurrence into chat, treating a timestamp as
sufficient when the latest refresh failed, incrementing a badge for every meaningful dashboard
change, sending browser push by default, rewriting the Event log to compact routine checks, and
using diagnostic Activity as product-facing Automation history.

## Amendment: explicitly requested recurring notifications (#263)

A user may explicitly request a recurring notification or reminder, including one with an empty
body. Its Automation stores a typed notification operation and submits each eligible occurrence
to the existing Notification Center without an outcome producer or a model call just to send it.
The shared per-device subscriptions, taint handling, interruption budgets, quiet hours, durable
outbox and retry policy still govern delivery. The recorded result is a request for notification
delivery, never proof that a device displayed it. Its deep link opens the owning Space's
Automations Surface, and it does not manufacture an assistant chat message.

This explicit operation does not change the dashboard-outcome policy above. Legacy generic jobs
are never reclassified by their free-text descriptions; an old unusable schedule can be explicitly
cancelled and replaced through Chat. See [issue #263](https://github.com/Ic3b3rg/veduta/issues/263)
for the accepted behavior and verification requirements.

Status: accepted
