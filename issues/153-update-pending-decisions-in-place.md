# 153 — Update Pending-decision feedback in place

## Parent

#141 — [Persist one Chat timeline per Chat scope](https://github.com/Ic3b3rg/veduta/issues/141)

Canonical specification: [issues/141-durable-chat-timelines.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/141-durable-chat-timelines.md)

## What to build

Represent a user-visible Pending decision as one durable Chat timeline entry whose state changes in place. The same stable entry moves from pending to resolving and then to its terminal outcome as the user decides and the Agent acts. Live updates, reload, reconnect, and pagination must converge on the latest revision without accumulating status messages.

Only information useful for making or understanding the decision belongs in Chat. Execution steps, tool calls, and trace detail remain in their existing internal records.

## Acceptance criteria

- [ ] A Pending decision entry has stable identity, turn identity, Chat scope, revision, decision content, allowed user responses, and a validated visible state.
- [ ] The initial Pending entry is durable before the user can act on it and survives reload and Gateway restart.
- [ ] Choosing a response updates that same entry to a resolving state rather than appending a second status entry.
- [ ] Completion, rejection, cancellation, failure, or interruption updates the same entry to one terminal outcome with truthful user-facing content.
- [ ] Repeated or out-of-order updates are idempotent and cannot regress a newer revision or produce duplicate entries.
- [ ] Offline and reconnect behavior converges to the latest canonical revision after the PWA returns.
- [ ] Pending decisions remain in the Chat scope of their originating turn and cannot appear or be answered from another scope.
- [ ] Multiple connected clients see the same current state; once one valid decision is accepted, stale actions from another client are rejected visibly.
- [ ] The Chat timeline excludes chain-of-thought, tool-call detail, trace payloads, and other execution internals.
- [ ] Gateway and PWA tests cover every terminal outcome, repeated and out-of-order revisions, stale responses, offline recovery, pagination, and multi-client convergence.
- [ ] A browser test proves one Pending entry updates in place from creation through a terminal outcome across reload.
- [ ] `pnpm check` passes.

## Blocked by

- #151
