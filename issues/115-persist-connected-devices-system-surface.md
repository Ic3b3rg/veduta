# 115 — Persist Connected devices as a living System Surface

## Parent

#63

## What to build

Replace the authenticated request-time Connected devices projection with one daemon-owned, persisted System Surface managed through the normal Surface engine lifecycle.

In production-auth mode, the manager materializes the stable daemon-private Connected devices Surface from the Gateway's authenticated-device state and refreshes it when a device is enrolled, renamed, or revoked. The current token check authorizes access to the installation; it does not define a per-request personalized device list, so persistence must not introduce a second visibility model or a new unauthenticated endpoint. Development mode should preserve the current behavior of not exposing a synthetic device inventory.

Every version is protocol-valid and follows the ordinary persisted lifecycle, Events, and live updates. If the source temporarily fails, keep the last valid Surface visible with an explicit stale or error indication and last successful timestamp, then repair it in place after recovery.

## Acceptance criteria

- [ ] Production-auth boot materializes exactly one protocol-valid Connected devices Surface inside the canonical System Space with its existing stable daemon-private identity.
- [ ] Enrollment, rename, and revocation refresh the persisted Surface without waiting for an `/api/spaces` request.
- [ ] Snapshot access remains protected by the existing authentication boundary, and no token-specific Surface variants or unauthenticated device API are introduced.
- [ ] Development mode does not expose a fabricated production device inventory.
- [ ] Each successful content change appends the required Space Event and reaches live snapshot subscribers.
- [ ] A failed refresh preserves the last valid content, visibly marks it stale or failed with its last successful timestamp, and a later success repairs it in place.
- [ ] The request-time Connected devices append path is removed, and focused auth, manager, failure, Event, and live-update tests plus the full repository gate are green.

## Blocked by

- #113
