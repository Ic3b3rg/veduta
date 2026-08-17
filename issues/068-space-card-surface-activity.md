# 068 — Show new Surface activity on Space cards

## Parent

#33

## What to build

Add a client-side new-activity indicator to each Space card so Home communicates that living Surface state changed without expanding every Surface.

Derive a Space's freshness from the most recent valid `updatedAt` across its Surfaces. Compare it with a per-Space last-seen timestamp stored locally. A Space with at least one Surface and no last-seen timestamp is new; opening the Space records the current freshness and clears the dot. A later Surface patch, creation, pin change, or other lifecycle update with newer freshness shows it again.

Keep storage parsing and time comparison in pure, testable state logic. Malformed or stale local data must degrade safely.

Preserve the existing server-backed attention lifecycle from issue #18. Server attention, pending-approval count, and the local activity dot are distinct signals and must not silently overwrite one another.

## Architectural boundary

The activity indicator is fixed shell derived state. It observes only validated metadata and never interprets the semantics, domain, state keys, or Atom types inside a Surface.

No protocol or Gateway change is required for this client-side signal, and no domain-specific freshness rules may be introduced.

## Acceptance criteria

- [ ] A Space with at least one Surface and no recorded last-seen timestamp shows a new-activity dot.
- [ ] A Space with no Surfaces does not show false activity.
- [ ] Opening a Space stores the current freshest Surface timestamp and clears its dot.
- [ ] A later live Surface lifecycle update with newer freshness restores the dot without a reload.
- [ ] Last-seen state survives reload and is isolated per Space.
- [ ] Malformed storage, invalid timestamps, clock-equal timestamps, and archived or newly-created Surfaces have explicit tested behavior.
- [ ] Opening a Space continues to run the server-backed mark-attention-seen behavior when applicable.
- [ ] The indicator derives only from metadata and does not inspect or special-case Atom trees.
- [ ] Focused pure-state, storage, live-update, and rendering tests plus the full repository gate are green.

## Blocked by

- #66
