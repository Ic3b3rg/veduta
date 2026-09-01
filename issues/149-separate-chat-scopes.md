# 149 — Separate global and Space Chat timelines

## Parent

#141 — [Persist one Chat timeline per Chat scope](https://github.com/Ic3b3rg/veduta/issues/141)

Canonical specification: [issues/141-durable-chat-timelines.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/141-durable-chat-timelines.md)

## What to build

Expand the durable Chat timeline into the two canonical Chat scope forms: one global timeline and one independent timeline for each Space. Scope is chosen when the user submits, persisted with every visible entry, and used consistently for authorization, retrieval, live delivery, and result placement.

A global turn may reason across Spaces but remains in the global timeline. A focused-Space turn remains in that Space's timeline. Navigating between Home and Spaces must switch timelines without leaking, moving, or duplicating entries.

## Acceptance criteria

- [ ] The shared contract represents exactly one global Chat scope or one focused-Space Chat scope with stable identity.
- [ ] Every submitted user entry captures its scope once and every Pending, final, or error result for that turn remains in the same scope.
- [ ] The Gateway persists and retrieves one global timeline plus one independent timeline per Space.
- [ ] Authorization prevents a client from reading, subscribing to, or writing a Space timeline it cannot access.
- [ ] A global turn that reads or mutates multiple Spaces remains visible only in the global timeline.
- [ ] A focused-Space turn remains visible only in that Space's timeline.
- [ ] Navigating Home → Space A → Space B → Home loads the correct history each time without entry leakage, movement, duplication, or loss.
- [ ] Reload and Gateway restart preserve all scopes and restore the currently selected scope.
- [ ] Concurrent global and focused-Space turns route live updates to their correct timelines.
- [ ] Gateway and PWA tests cover scope creation, authorization, navigation, concurrent turns, reload, and restart.
- [ ] A browser test proves global, Health, and Work conversations remain isolated across navigation and reload.
- [ ] `pnpm check` passes.

## Blocked by

- #144
