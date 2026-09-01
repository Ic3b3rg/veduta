# 154 — Retire browser-local chat authority and prove clean-root durability

## Parent

#141 — [Persist one Chat timeline per Chat scope](https://github.com/Ic3b3rg/veduta/issues/141)

Canonical specification: [issues/141-durable-chat-timelines.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/141-durable-chat-timelines.md)

## What to build

Complete the authority transition to Gateway-owned Chat timelines and remove the browser-local transcript path. Legacy `veduta.chatHistory` data cannot be assigned trustworthy identity, time, or Chat scope, so it is neither uploaded nor migrated. Stop using it as authority while leaving existing legacy data untouched for a separate future removal decision. Start verification from a clean isolated data root; do not make destructive reset part of normal runtime behavior.

The PWA may keep disposable caches or idempotent transport queues, but neither may define history, retention, scope, ordering, or terminal state. Prove the completed model across global, Health, and Work scopes, including live-turn recovery and Pending decisions.

## Acceptance criteria

- [ ] The PWA no longer reads from or writes to `veduta.chatHistory` as Chat timeline authority.
- [ ] No legacy transcript upload, canonical migration, or compatibility fallback remains; startup does not delete existing legacy browser data, and a clean isolated data root is the supported verification starting point.
- [ ] The Gateway is the sole authority for visible entry identity, content, scope, order, retention, pagination, lifecycle, and revision.
- [ ] Any browser cache is disposable and rebuilding it from the Gateway yields the same timeline.
- [ ] Any transport queue carries stable idempotency identity and cannot synthesize, reorder, retain, or delete Chat history.
- [ ] Global, Health, and Work conversations remain complete and isolated after navigation, reload, Gateway restart, and clearing all browser storage.
- [ ] A running turn reloads into the same live turn, an orphaned turn becomes Interrupted with explicit Retry, and neither path duplicates execution.
- [ ] A Pending decision updates one entry in place through its terminal outcome across reload and reconnect.
- [ ] More than 80 entries remain reachable through pagination; no browser cap destroys authoritative history.
- [ ] Correctness does not depend on an LLM provider's conversation thread, memory, or provider-specific transcript format.
- [ ] Mock-provider automation and documented real-ChatGPT smoke checks exercise the same Gateway contracts.
- [ ] Clean-root browser E2E covers the complete global/Health/Work scenario and removes its persistent test artifacts.
- [ ] Relevant browser E2E passes and `pnpm check` passes.

## Blocked by

- #152
- #153
