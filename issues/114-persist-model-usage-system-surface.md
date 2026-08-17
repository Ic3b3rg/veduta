# 114 — Persist Model usage as a living System Surface

## Parent

#63

## What to build

Replace the request-time Model usage projection with one daemon-owned, persisted System Surface managed through the normal Surface engine lifecycle.

The manager materializes the stable daemon-private Model usage Surface at boot, refreshes it when usage accounting or the usage day changes, validates every version through the shared protocol, and emits the same lifecycle Events and live updates as other persisted Surfaces. Reading `/api/spaces` must not be what creates or refreshes it.

If the usage source temporarily fails, keep the last valid Surface visible, add an explicit stale or error indication with the last successful timestamp, and recover the same Surface in place on the next successful refresh. Do not add a PWA-specific renderer or expose the Surface identity as a client contract.

## Acceptance criteria

- [ ] Boot materializes exactly one protocol-valid Model usage Surface inside the canonical System Space with its existing stable daemon-private identity.
- [ ] Accepted usage accounting and usage-day rollover refresh the persisted Surface without waiting for an `/api/spaces` request.
- [ ] Each successful content change follows the normal Surface lifecycle, appends the required Space Event, and reaches live snapshot subscribers.
- [ ] A failed refresh preserves the last valid content, visibly marks it stale or failed with its last successful timestamp, and a later success repairs it in place.
- [ ] Repeated equivalent refreshes do not create duplicate Surfaces or duplicate semantic updates.
- [ ] The Model usage Surface remains a generic validated Atom tree with no client-side identity switch or bespoke renderer.
- [ ] The request-time Model usage append path is removed, and focused manager, failure, Event, and live-update tests plus the full repository gate are green.

## Blocked by

- #113
