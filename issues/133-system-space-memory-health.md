# 133 — Expose memory health through the System Space

## Parent

#32

Repository specification:
[issues/133-system-space-memory-health.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/133-system-space-memory-health.md)

## What to build

Persist one Gateway-owned `Memory health` Surface in the canonical System Space. It is the source
of truth for every Space's rendered active FACTS size, watermark state, pending-Reflection state,
last update time, and any over-hard recovery condition. It also lists non-blocking size warnings for
user-controlled `USER.md`, `SOUL.md`, and each Space's `INSTRUCTIONS.md` when an individual document
exceeds 2,000 UTF-16 code units.

Measure only user-controlled content actually injected into context, excluding Gateway policy and
rendering wrappers. Show the document, owning Space (or global scope), measured size, and threshold.
These document warnings and the `high` FACTS state appear only on the living Surface: they do not
block work or create notifications.

When a Space first enters `hard`, create one durable In-app notification in the System Space linked
to `Memory health` and focused on that Space. Each over-hard Space has its own notification. Repeated
audits update that open notification rather than creating duplicates. Recovery closes the over-hard
notification and creates one recovery notification. Boot, reconnect, and restore must preserve this
state without notification spam. Do not emit browser push, Space-attention badges, or assistant
chat messages.

## Acceptance criteria

- [ ] The canonical System Space contains one schema-valid, persistent `Memory health` Surface with
      a visible last-update time.
- [ ] The Surface reports each Space's active projection size, low/high/hard status, pending
      Reflection, and pre-existing over-hard recovery state.
- [ ] `USER.md`, `SOUL.md`, and `INSTRUCTIONS.md` warnings use a per-document 2,000-unit threshold
      over injected user-controlled content only and identify document, scope/Space, size, and
      threshold.
- [ ] `high` and human-document warnings remain non-blocking Surface state and create no
      notification.
- [ ] Each over-hard Space owns one coalescing In-app notification in the System Space that opens the
      relevant `Memory health` view.
- [ ] Recovery settles the active warning and creates one recovery notification;
      restart/reconnect/restore cannot duplicate or resurrect stale notifications.
- [ ] The feature creates no browser push, attention badge, or assistant chat message.
- [ ] Protocol, daemon, PWA, persistence, accessibility, and browser tests cover the Surface,
      navigation, coalescing, recovery, and deduplication, and `pnpm check` passes.

## Blocked by

- #91
- #100
- #113
- #130
