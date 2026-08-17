# 112 — Keep shared Surface order convergent through races and recovery

## Parent

- #106

## What to build

Close the shared-order lifecycle under real Gateway conditions. Independent browser sessions must
converge live and after missed events, fresh sessions and reloads must reconstruct the same order,
Gateway restart must retain it, and ordering work from another client must never hijack the local
viewport. Add the real-browser acceptance journey and concise manual test script that prove those
contracts and close any recovery gaps they expose.

## Acceptance criteria

- [ ] Two isolated browser sessions begin with the same canonical Pinned and regular order, including a fresh browser with no prior local storage.
- [ ] Effective Pin, Unpin, and Move in either session converge both sessions to the same visible order without a normal-path snapshot refetch.
- [ ] HTTP response and WebSocket delivery in either order, including duplicate confirmed results, cannot create divergent membership, position, freshness, or cursor state.
- [ ] Remote-client, Agent-driven, and replayed ordering changes leave the observing browser's viewport, route, selected Surface, and keyboard focus unchanged.
- [ ] Reload preserves manual arrangement instead of reconstructing last-pinned-first defaults after authoritative order exists.
- [ ] Gateway restart retains the canonical order and returns it to both existing and fresh browser sessions.
- [ ] A reconnect after missed events converges through replay or snapshot reconciliation without duplicating or omitting an active Surface.
- [ ] Offline Home retains the last confirmed order, refuses every ordering mutation without queuing it, and reconnects without applying stale intent.
- [ ] The real-Gateway Playwright journey covers grouping, counts, local Pin reveal, boundary Moves, Unpin placement, pending and failure behavior, offline refusal, reduced motion, two-client quiet convergence, reload, replay/reconciliation, and restart persistence through accessible observations.
- [ ] Migration integration coverage boots representative pre-order data containing creation, Pin, Unpin, ties, missing history, archived Surfaces, and multiple Spaces and asserts public snapshots and Event behavior.
- [ ] A concise manual UI script covers direct Pin, Move, Unpin, reload, two browser sessions, offline failure, and reduced motion.
- [ ] Focused automated checks, the explicit real-browser journey, and pnpm check pass.

## Blocked by

- #109
- #110
- #111
