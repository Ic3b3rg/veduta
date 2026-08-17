# 065 — Make Space and Surface routes the navigation source of truth

## Parent

#33

## What to build

Turn the declared Space and Surface paths into a real generic Space drill-down.

`/app/space/:spaceSlug` renders only the selected Space and its Surfaces. The nested Surface path renders the same Space view and positions or focuses the requested Surface. The Space rail, Home breadcrumb, Surface focus controls, browser history, direct loads, and service-worker navigation all use the same router path.

Derive the global chat scope from the active route: chat is global on Home and scoped to the open Space on both Space and Surface routes. Remove parallel focus state, the hand-written deep-link parser, manual `pushState`, and the `popstate` listener once route parameters own the selection.

Unknown Space and Surface parameters must produce an explicit, recoverable state with a route back to Home rather than silently showing an unrelated view.

## Architectural boundary

The Space view is a generic fixed-shell container. It knows how to select a Space and arrange its validated Surfaces, but it has no domain-specific renderers for Health, Work, System, or any future Space.

Every Surface remains living GenUI state: its validated Atom tree is handed unchanged to the catalog renderer, and its fast path, agent path, pinning, ordering, and live patch behavior remain intact.

## Acceptance criteria

- [ ] `/app/space/:spaceSlug` renders exactly one Space and never leaks Surfaces from another Space.
- [ ] `/app/space/:spaceSlug/surface/:surfaceId` opens the owning Space and visibly positions or focuses the requested Surface.
- [ ] The rail performs lateral route navigation between Spaces, and the Home control navigates to `/`.
- [ ] Browser Back and Forward, direct load, refresh, clicks, and service-worker navigation produce the same selected Space and Surface.
- [ ] Chat is global on Home and scoped from route parameters inside a Space, without a second focused-Space state.
- [ ] Unknown or mismatched Space and Surface parameters render a visible recovery state instead of falling back to Home.
- [ ] Surface rendering and actions still pass through protocol validation and the catalog, with no domain-specific Space components.
- [ ] The manual pathname parser and browser-history listeners owned by the application are removed.
- [ ] Focused route, chat-scope, Surface-action, and live-update tests plus the full repository gate are green.

## Blocked by

- #64
