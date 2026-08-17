# 045 — Preserve consecutive one-shot fast actions across HTTP and realtime races

## Verified bug

A one-shot fast action optimistically sets its state key in the browser, receives an HTTP Surface
response, and later receives the daemon's healing realtime patch that resets the key. Because the
HTTP response and realtime event are not reconciled under one freshness rule, an older response can
overwrite the reset. The next identical tap then appears unchanged locally and can be swallowed as
an idempotent replay even though the daemon is ready for another invocation.

The daemon-side reset is covered and working; the remaining defect is browser reconciliation of the
two delivery paths.

## Desired behavior

Every deliberate tap is delivered once, including repeated taps with the same declared payload.
Realtime state that is newer than an action response must remain authoritative, without weakening
idempotency for retries or creating duplicate fast-path Events.

## Acceptance criteria

- [ ] Repeated taps of one one-shot fast action in a single page session invoke its handler once per
      tap without a reload.
- [ ] An older HTTP action response cannot overwrite a newer realtime Surface patch.
- [ ] Retrying the same network request remains idempotent and does not duplicate the handler or
      Space Event.
- [ ] The Updates Surface's `Check now` action works on consecutive taps.
- [ ] A PWA state test reproduces both HTTP/realtime delivery orders, and a browser journey covers
      the user-visible regression.
- [ ] `pnpm check` passes, followed by the relevant browser E2E job.

## Out of scope

- Changing ordinary toggle semantics.
- Removing optimistic feedback from all fast actions.
- Introducing free-form or provider-owned action handling.

## Blocked by

None — can start immediately.
