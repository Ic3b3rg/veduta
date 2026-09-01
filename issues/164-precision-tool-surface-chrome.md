# 164 — Apply Precision Tool chrome to Surfaces and ordering controls

## Parent

#157 — [Adopt the product-first Precision Tool UI direction](https://github.com/Ic3b3rg/veduta/issues/157)

Canonical specification: [issues/157-product-first-precision-tool-ui.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/157-product-first-precision-tool-ui.md)

## What to build

Apply the Precision Tool material, geometry, and interaction recipes to Surface hosts after the
canonical pinned-group and ordering controls are in place. Durable Surface content becomes an
opaque, low-elevation plane with a compact predictable toolbar, while existing ordering, Pin,
routing, Agent reveal, and fast-path behavior remain owned by their canonical issues.

## Acceptance criteria

- [ ] Durable Surface content renders on an opaque, high-contrast plane with restrained radii,
      crisp dividers, modest elevation, disciplined metadata, and no decorative glass or glow.
- [ ] The accessible toolbar order is exactly Move Up, Move Down, then Pin when Pin is available.
- [ ] Move Up and Move Down form the left-hand ordering group and expose canonical boundary,
      pending, disabled, and error states without changing Gateway-confirmed behavior.
- [ ] Pin is an icon-only recognizable thumbtack on the right, keeps one stable accessible name,
      exposes pressed state separately, and provides a text tooltip.
- [ ] Non-pinnable daemon-owned Surfaces continue to omit Pin, and no presentation introduces a
      numeric Pin limit.
- [ ] No visible or assistive-technology-exposed Focus action remains on a Surface.
- [ ] Direct routes still identify the current Surface; ordinary Atom actions, Move, Pin, and Unpin
      preserve route, selected Surface, scroll context, and keyboard focus except for the separate
      local feedback explicitly owned by canonical behavior.
- [ ] Initiating-turn Surface reveal, direct-Pin feedback, remote updates, and reduced-motion
      variants remain event-specific and localized rather than becoming navigation or ambient
      animation.
- [ ] Keyboard focus is visible, traversal order is logical, and frequent coarse-pointer toolbar
      controls provide at least 44-by-44-pixel targets.
- [ ] Representative standard, full, long, empty, stale, updated, loading, error, and unknown-version
      Surface states remain legible without clipping or horizontal overflow.
- [ ] Component, app-routing, and browser tests cover accessible toolbar order and state, absence of
      Focus, route and focus preservation, reveal boundaries, and phone/desktop rendering.
- [ ] `pnpm check` passes.

## Blocked by

- #162
- #109
- #110
- #111
