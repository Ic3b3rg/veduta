# 109 — Render accessible Pinned and regular Surface groups

## Parent

- #106

## What to build

Present the Gateway's canonical order as two clear groups inside each Space. Pinned appears first
and visibly communicates prominence; regular Surfaces follow without the PWA re-sorting either
group. Empty groups disappear, group boundaries constrain the existing Move controls, and the
visual structure remains understandable through assistive technology.

## Acceptance criteria

- [ ] Every non-empty Pinned group renders before every regular Surface in the same Space and preserves the authoritative order supplied by the Gateway.
- [ ] Pinned has an accessible heading or equivalent group label that includes its current Surface count.
- [ ] The Pinned group renders only when non-empty, and an empty regular group consumes no layout space.
- [ ] The existing No Surfaces state renders only when both groups are empty.
- [ ] A Space containing only Pinned Surfaces, only regular Surfaces, or both groups has no empty placeholder or drop target.
- [ ] Move Up and Move Down operate only inside the Surface's current group and are disabled at that group's first and last positions.
- [ ] No Move control can cross the Pinned boundary; only Pin and Unpin change group membership.
- [ ] Pin controls remain absent for non-pinnable daemon-owned Surfaces, and presentation introduces no numeric Pin limit.
- [ ] Multiple Spaces derive and label their groups independently without one Space's order affecting another.
- [ ] Component and app-level tests assert accessible roles, labels, group counts, empty states, visible group order, and boundary-control behavior rather than styling-only selectors.
- [ ] pnpm check passes.

## Blocked by

- #108
