# 066 — Replace the expanded Home with an at-a-glance Space grid

## Parent

#33

## What to build

Replace the current Home that expands every Surface with a reusable fixed-shell composition of Space groups and Space cards.

Each active Space card shows its name, Surface count, freshest Surface timestamp, an attention area, and an intentionally empty slot reserved for a future Space description. The card is a generic summary of validated Space and Surface metadata; it does not render or inspect the Space's Atom trees.

Show user life-area Spaces first. Show the one canonical System Space in a visually secondary System group. The PWA must consume that System Space from the validated snapshot and must never synthesize it, classify a user-authored Space by name, or introduce a bespoke System renderer. Consume the completed System snapshot contract from #117 before implementing this slice.

When the canonical System Space is the only Space, show a gentle invitation to create the first user Space from chat above the System group.

## Architectural boundary

Space cards and groups are fixed shell components, not Atoms and not Agent-composable UI. They remain generic across all life areas: no Health card, Work card, or other domain component may be hardcoded.

The Agent continues to bring the data by creating Spaces and composing validated Surface Atom trees. Users see those trees only after drilling into a Space. Shared visual values come from the catalog design tokens; this ticket does not create a second design system.

## Acceptance criteria

- [ ] `/` shows one card for every active Space and renders no Surface Atom tree or Surface card.
- [ ] Every card shows name, Surface count, freshness, and the reserved description slot without inventing a protocol field or placeholder description.
- [ ] Card counts and freshness update when the validated snapshot or live Surface lifecycle changes.
- [ ] User life-area Spaces appear before a visually secondary group containing only the canonical System Space.
- [ ] The System Space is recognized by its engine-owned canonical identity, never by its display name, and is rendered by the same generic Space view as every other Space.
- [ ] Clicking or keyboard-activating a card navigates to the matching Space route.
- [ ] An installation with only the System Space shows the create-first-Space invitation instead of an empty or desolate Home.
- [ ] Cached/offline, loading, empty, and malformed local-state paths remain visible and recoverable.
- [ ] The implementation introduces no domain-specific Space renderer, no generated routes, and no new Atom type.
- [ ] Focused Home-state and accessibility tests plus the full repository gate are green.

## Blocked by

- #65
- #117
