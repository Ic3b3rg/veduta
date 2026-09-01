# 165 — Make Chat and Pending decisions the subordinate interaction layer

## Parent

#157 — [Adopt the product-first Precision Tool UI direction](https://github.com/Ic3b3rg/veduta/issues/157)

Canonical specification: [issues/157-product-first-precision-tool-ui.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/157-product-first-precision-tool-ui.md)

## What to build

Apply the Precision Tool interaction-layer contract to Chat, Pending decisions, and their
notification and feedback states. Chat remains always available as the tool for changing persistent
state but no longer visually outranks Home or the active Space. Translucency is optional and limited
to a transient region where seeing underlying context directly helps the task.

Preserve all current Chat scopes, delivery, Pending-decision outcomes, reveal semantics, routes, and
focus behavior. This ticket changes their visual hierarchy and state recipes only.

## Acceptance criteria

- [ ] Chat remains continuously reachable but uses a quieter hierarchy than durable Home and Space
      content on both phone and desktop.
- [ ] Durable timeline and decision content is opaque; any translucent floating or transient region
      has a documented contextual purpose, avoids nesting, and remains fully usable with its opaque
      fallback.
- [ ] Phone composition keeps the active task and composer reachable without scaled-down desktop
      chrome, overlap, pointer-only controls, or horizontal overflow.
- [ ] Pending decisions appear in their established product region with distinct pending, resolving,
      success, rejection, failure, and stale-action treatments without changing durable semantics.
- [ ] Streaming, long content, empty history, loading, errors, offline state, and queued work retain
      the same component quality and hierarchy as the happy path.
- [ ] Success, warning, danger, freshness, attention, offline, queued, and Pending meanings use
      separate semantic treatments and never rely on color alone.
- [ ] Composer, decision, notification, and retry controls have stable accessible names, visible
      focus, logical traversal, readable disabled and error states, and coarse-pointer targets.
- [ ] Ordinary Chat and decision interaction preserves route-derived selection and keyboard focus;
      qualifying reveal remains programmatic, localized, and event-specific.
- [ ] Motion is brief, interruptible, and tied to insertion or state change; reduced motion removes
      movement without removing the visible state transition.
- [ ] Component and browser tests exercise representative Chat and Pending states, opaque fallback,
      keyboard behavior, reduced motion, and the 320-pixel and 1440-pixel compositions.
- [ ] `pnpm check` passes.

## Blocked by

- #162
