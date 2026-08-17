# 110 — Keep Surface-order mutations confirmed, online-only, and single-flight

## Parent

- #106

## What to build

Make Pin, Unpin, and Move truthful under latency, failure, and disconnection. Home keeps the last
Gateway-confirmed order until a mutation succeeds, prevents duplicate input while that Surface's
order mutation is in flight, and refuses offline ordering work instead of placing it in any queue.

## Acceptance criteria

- [ ] Pin, Unpin, and Move are non-optimistic: starting a request does not change group membership, position, freshness, or visible order.
- [ ] While one Surface-order mutation is pending, the affected ordering controls expose a pending/disabled state and repeated activation cannot send a duplicate request.
- [ ] A confirmed authoritative response updates Home exactly once even if the matching live event arrives before or after the HTTP response.
- [ ] A failed or rejected request preserves the prior confirmed order and presents an accessible error that identifies the failed Surface action.
- [ ] When the Gateway is offline, Pin, Unpin, and Move report that they are unavailable and leave the last cached canonical order readable.
- [ ] Offline ordering commands never enter chat, fast-action, service-worker, or any new deferred queue and therefore cannot replay after reconnection.
- [ ] Reconnection permits an explicit retry but does not silently retry an ordering command issued while disconnected.
- [ ] Pending state is scoped narrowly enough that unrelated Surfaces remain usable without allowing conflicting duplicate input for the affected Surface.
- [ ] Unit and app-level tests cover delayed success, HTTP/live delivery in either order, duplicate activation, rejection, transport failure, offline refusal, reconnect, unchanged order, and unchanged queued-work counts.
- [ ] pnpm check passes.

## Blocked by

- #108
