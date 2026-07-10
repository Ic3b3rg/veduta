# 029 — Progressive Surface composition: layout first, slots fill as they are ready

## Context

Today a Surface only becomes visible when the Agent has finished composing the entire Atom tree.
While the Agent works, the user sees nothing (new Surface) or stale content (regeneration), with
no indication of what is coming. Showing the layout immediately — with typed placeholders where
content is still being produced — gives the user an early mental model of the result and makes
Agent latency feel like progress instead of silence.

A streaming wire format was considered and rejected: emitting one node per line with nesting by
reference would let structure arrive before content at the transport level, but it would put a
second format to parse, validate, and secure next to the validated Atom tree + patch contract.
The same user experience is reachable inside the existing contract: the daemon already applies
and broadcasts Surface patches, so "structure first, content later" is a composition pattern —
create the Surface with pending slots, patch each slot as it resolves — not a wire-format change.

## Goal

A Surface under composition shows its full layout immediately, with skeleton placeholders in the
regions the Agent has not filled yet; each region is filled by a patch as soon as it is ready,
within the existing tree + patch protocol.

## Tasks

- Pending-slot representation in the protocol: a small, schema-validated way to mark an Atom
  position as "content pending" (a dedicated Atom type or equivalent). It follows the
  `UnknownAtom` guarantee: renders visibly, never crashes, never disappears. This touches
  `packages/protocol`, so plan mode first.
- Skeleton renderers in the catalog: typed placeholder variants that match the footprint of what
  they stand in for (text block, list rows, image, stat/chart), driven by design-system tokens.
- Composition pattern on the daemon side: the Surface engine lets the Agent create a Surface as
  layout plus pending slots and fill each slot with a patch, instead of one monolithic write.
  Document the pattern where the Agent-facing tool guidance lives.
- A pending slot never persists forever: define the timeout/error behavior when the Agent fails
  to fill it (a visible fallback state, not a stuck skeleton).
- Entrance interplay with [issue 028](028-surface-motion.md): a slot being filled replaces its
  skeleton using the entrance transition, so progressive fill and staggered reveal feel like one
  system.

## Acceptance criteria

- Creating a Surface shows its layout with skeleton placeholders before content exists, verified
  in a real browser against the dev daemon
- Each region fills independently as its patch arrives; already-filled regions do not re-render
  or re-animate
- A slot the Agent never fills degrades to a visible fallback state within a bounded time
- Every new protocol shape is zod-validated; malformed pending or fill payloads render as
  visible fallbacks, never crash and never disappear

## Dependencies

002, 007, 008 (motion polish lands with [issue 028](028-surface-motion.md))
