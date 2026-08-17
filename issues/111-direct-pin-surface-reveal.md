# 111 — Reveal only a directly pinned Surface

## Parent

- #106

## What to build

After an effective Pin initiated by the current tab is confirmed and rendered in its authoritative
position, bring that Surface to the viewport centre and briefly highlight it. The feedback is
strictly local presentation state: it must not turn Pin into navigation, selection, or focus
movement, and no other Pin or Unpin source may move the viewport.

## Acceptance criteria

- [ ] An effective Pin directly initiated in the current tab waits for Gateway confirmation and the reordered render before centring the Surface in the viewport.
- [ ] The directly pinned Surface receives a brief, observable local highlight after it reaches its confirmed position.
- [ ] A failed Pin and an idempotent request for an already pinned Surface neither scroll nor highlight.
- [ ] Direct Unpin never scrolls or highlights.
- [ ] Agent-driven Pin, another client's Pin, reconnect replay, and snapshot reconciliation update order without scrolling or highlighting this tab.
- [ ] Pin feedback does not change the current URL, focused Space, selected Surface, or keyboard focus.
- [ ] With reduced motion requested, positioning is immediate and the highlight remains visible without animation.
- [ ] Without reduced motion, smooth positioning and the brief highlight complete without leaving persistent shared or cached state.
- [ ] Tests distinguish direct intent from remote and replayed events explicitly rather than inferring origin from timing or the currently active chat turn.
- [ ] Browser-facing tests cover off-screen Pin, focus and route preservation, reduced motion, failed and idempotent Pin, quiet Unpin, and quiet remote/replayed Pin.
- [ ] Revealing a Surface created by a local chat turn remains outside this ticket and under #107.
- [ ] pnpm check passes.

## Blocked by

- #108
