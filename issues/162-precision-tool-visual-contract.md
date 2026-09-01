# 162 — Encode the Precision Tool visual contract in a deterministic reference inventory

## Parent

#157 — [Adopt the product-first Precision Tool UI direction](https://github.com/Ic3b3rg/veduta/issues/157)

Canonical specification: [issues/157-product-first-precision-tool-ui.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/157-product-first-precision-tool-ui.md)

## What to build

Turn the approved Precision Tool direction into an executable visual contract before migrating the
production screens. Add a repository-open visual-language document, deepen the existing catalog
token boundary with named semantic component recipes, and expose one deterministic contributor
inventory that renders Veduta's real product regions and complete Atom catalog with representative
state.

This is the expand phase of the visual-system migration. The new semantic roles may coexist with
legacy visual aliases so the repository remains green while later tickets migrate each product
area. It must not add a second design system, a component framework, free-form Surface styling, or
new product behavior.

## Acceptance criteria

- [ ] A durable visual-language document defines the dark-only direction, opaque durable-content
      plane, optional transient interaction plane with opaque fallback, semantic color roles,
      geometry, typography, density, motion purposes, responsive adaptation, prohibited defaults,
      and the contribution gate for extending the system.
- [ ] Shared surfaces, controls, inputs, menus, overlays, status treatments, focus, and motion use
      named semantic recipes rooted in the existing catalog token boundary; shell-only roles remain
      explicit.
- [ ] The recipes do not add shadcn, Tailwind, another component dependency, a second token system,
      raw generated CSS, a new Atom, or a protocol or Gateway contract.
- [ ] One deterministic contributor inventory represents Home, Space detail, Surface chrome, Chat,
      Pending decisions, onboarding, Model connections, and every supported Atom.
- [ ] The inventory includes realistic long, empty, loading, stale, updated, error, offline, queued,
      and reduced-motion cases rather than relying only on ideal seed data.
- [ ] Inventory fixtures do not depend on live network calls, wall-clock drift, randomness, or
      installation-specific state, so repeated browser captures are comparable.
- [ ] The inventory can be reviewed at 320-pixel phone and 1440-pixel desktop widths in the supported
      dark appearance and exposes stable accessible landmarks and names for automation.
- [ ] Existing production consumers may continue using legacy aliases during this expand ticket,
      but every newly introduced recipe is demonstrated through the inventory and covered by tests.
- [ ] Automated checks fail when a supported Atom or required representative product state
      disappears from the inventory or a shared recipe refers to an undeclared catalog token.
- [ ] `pnpm check` passes.

## Blocked by

None — can start immediately.
