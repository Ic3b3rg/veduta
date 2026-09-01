# 163 — Apply Precision Tool hierarchy to the shell, Home, and Space navigation

## Parent

#157 — [Adopt the product-first Precision Tool UI direction](https://github.com/Ic3b3rg/veduta/issues/157)

Canonical specification: [issues/157-product-first-precision-tool-ui.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/157-product-first-precision-tool-ui.md)

## What to build

Apply the shared Precision Tool recipes to the production shell, Home, and route-derived Space
navigation. Make Spaces and living Surfaces visually primary through compact dark chrome, disciplined
density, quiet utilities, crisp separation, and phone/desktop compositions that preserve the
existing navigation and reveal contracts.

This ticket owns the product hierarchy around Surfaces, not Surface toolbar behavior or the visual
contract of Chat and setup flows.

## Acceptance criteria

- [ ] The application shell uses compact dark chrome and crisp structure without broad glass,
      decorative glow, large soft shadows, ambient motion, or adjacent nested translucent regions.
- [ ] The Veduta wordmark is direct and quiet, without an ornamental status dot or environment copy
      competing with product state.
- [ ] Model connections, installation, and notification utilities remain discoverable through
      compact controls with stable accessible names and visible focus.
- [ ] Home gives Space identity, freshness, attention, Pending decisions, and Surface count one
      consistent scan hierarchy while keeping durable content visually primary.
- [ ] Space navigation and selected state remain derived from canonical routes; direct Space and
      Surface links stay unambiguous without inventing a parallel selection model.
- [ ] Wide screens use parallel context and readable density, while phone composition progressively
      discloses secondary metadata and keeps one clear job in view.
- [ ] Long names, translated metadata, empty Spaces, stale state, loading, errors, and attention
      states wrap or truncate intentionally without overlap or horizontal overflow at the reference
      widths.
- [ ] Route changes, service-worker navigation, route recovery, and qualifying programmatic reveal
      retain their established behavior, URL, scroll, and keyboard-focus boundaries.
- [ ] Frequent coarse-pointer controls provide at least 44-by-44-pixel targets without forcing
      desktop controls to look oversized.
- [ ] Component and routing tests assert accessible hierarchy and behavior; deterministic browser
      evidence covers the 320-pixel and 1440-pixel reference compositions.
- [ ] `pnpm check` passes.

## Blocked by

- #162
