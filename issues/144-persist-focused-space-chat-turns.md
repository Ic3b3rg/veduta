# 144 — Persist completed focused-Space turns across reload

## Parent

#141 — [Persist one Chat timeline per Chat scope](https://github.com/Ic3b3rg/veduta/issues/141)

Canonical specification: [issues/141-durable-chat-timelines.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/141-durable-chat-timelines.md)

## What to build

Deliver the first durable Chat timeline slice for a completed turn in one focused Space. The Gateway becomes authoritative for visible user and final Agent entries: it records the user entry before execution, records a terminal final or error entry, assigns stable identities and timestamps, and returns the latest page to an authenticated PWA after reload.

This slice must keep the Chat timeline distinct from Agent sessions, traces, and the Space Event log. The existing browser-local transcript may coexist temporarily only as an expansion seam; it must not overwrite Gateway-owned entries.

## Acceptance criteria

- [ ] The Gateway persists Chat timeline entries with stable entry identity, focused-Space scope, role or visible status, timestamp, content, and an ordering cursor.
- [ ] Every Chat submission carries a client-generated stable identity; the Gateway durably records
      the user entry and accepted turn before acknowledging it or beginning Agent execution.
- [ ] The PWA removes a submission from its visible retry queue only after durable acceptance is
      acknowledged; losing that acknowledgement and resending the same identity returns the same
      turn.
- [ ] A completed turn records exactly one terminal final Agent entry; an execution failure records one visible error entry.
- [ ] Retried or repeated transport submissions with the same client identity do not duplicate the user entry or Agent execution.
- [ ] An authenticated API returns the latest page for the requested focused Space and cannot expose another inaccessible Space.
- [ ] The PWA hydrates that page and shows the same completed conversation after reload and Gateway restart.
- [ ] Agent session and trace records remain execution internals and are not presented as Chat timeline entries.
- [ ] Space Event records remain the mutation audit trail and are not reused as transcript storage.
- [ ] Any temporary browser-local transcript path cannot replace, reorder, or duplicate Gateway-owned entries.
- [ ] Gateway and PWA tests cover success, error, duplicate submission, authorization, reload, and restart.
- [ ] A browser test proves a focused-Space conversation survives reload from a clean isolated data root.
- [ ] `pnpm check` passes.

## Blocked by

- #155
