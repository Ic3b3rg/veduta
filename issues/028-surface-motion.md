# 028 — Surface motion: staggered entrance and region-scoped update feedback

## Context

Surfaces currently appear and update with no motion at all: a new Surface pops in fully formed,
and a patch re-renders the card with no cue about what changed. The design system has a single
motion token (`fast: 120ms ease`) and the only animated element in the catalog is the
`Transition` Atom's opacity toggle. For a product whose Surfaces are living state maintained by
the Agent, motion is not decoration: it tells the user "this just arrived" and "this specific
part changed", which is core to trusting an interface that updates itself.

## Goal

A motion layer for Surfaces, entirely in `catalog` and `pwa` with no protocol change: new content
enters with a staggered top-down reveal, and a patched region signals its own update while the
rest of the Surface stays still.

## Tasks

- Extend the design-system motion tokens beyond the single `fast` value: entrance duration and
  easing, per-sibling stagger interval, update-feedback duration. No hardcoded durations in
  renderers.
- Entrance animation in the renderer: Atoms are already keyed by node id, so newly mounted nodes
  can fade + slide in, staggered by sibling index, producing a top-down fill when a Surface first
  renders. Atoms whose id persists across a re-render must not re-animate.
- Region-scoped update feedback: patch operations carry paths, so the changed subtree is known.
  Mark only that region (brief highlight or soft shimmer overlay) while the previous content
  stays visible underneath; sibling Atoms must not flash or reflow.
- Respect `prefers-reduced-motion`: entrance and update feedback degrade to an instant,
  motion-free render.
- Showcase entries for the motion states, so contributors can see entrance and update feedback
  without wiring a daemon.

## Acceptance criteria

- A newly created Surface fills top-down with a staggered entrance, verified in a real browser
  in light and dark
- Applying a patch to one region visibly marks that region only; Atoms outside the patched
  subtree do not re-animate or flash
- With `prefers-reduced-motion: reduce`, Surfaces render instantly with no entrance or shimmer
- `packages/protocol` is untouched; every timing comes from a design-system motion token

## Dependencies

008
