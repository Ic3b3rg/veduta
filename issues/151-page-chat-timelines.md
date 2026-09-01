# 151 — Page and converge complete Chat timelines

## Parent

#141 — [Persist one Chat timeline per Chat scope](https://github.com/Ic3b3rg/veduta/issues/141)

Canonical specification: [issues/141-durable-chat-timelines.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/141-durable-chat-timelines.md)

## What to build

Make each Gateway-owned Chat timeline complete over time through cursor pagination and deterministic convergence. The PWA loads the latest page, requests older pages without gaps, and merges persisted and live entries by stable identity and ordering rather than arrival timing.

Remove the current destructive 80-entry behavior from the authoritative model. Global history is retained for the installation lifetime; a Space timeline remains available through Space archival. Browser storage may act only as a disposable cache while the final legacy path is retired later.

## Acceptance criteria

- [ ] Chat timeline retrieval uses opaque stable cursors with a documented page-size contract and deterministic order for entries sharing a timestamp.
- [ ] The PWA loads the newest page first and can repeatedly load older pages until the beginning without gaps, duplicates, or reordered entries.
- [ ] Persisted pages and live updates merge by stable entry identity, so network delay, reconnect, and repeated responses converge to one ordered timeline.
- [ ] Multiple connected clients converge after concurrent submissions and after either client reconnects.
- [ ] Gateway restart preserves all pages and cursor behavior.
- [ ] Clearing browser storage cannot delete authoritative Chat history.
- [ ] No authoritative 80-entry cap or other silent destructive truncation remains.
- [ ] The global Chat timeline is retained for the installation lifetime.
- [ ] A Space Chat timeline remains retrievable after that Space is archived, subject to the same access rules.
- [ ] Any browser cache is disposable, scoped, and unable to overwrite newer Gateway state.
- [ ] Gateway and PWA tests cover page boundaries, equal timestamps, repeated pages, live-page races, reconnect, multi-client convergence, restart, archival, and cleared browser storage.
- [ ] A browser test creates more than one page of entries and proves complete history across reload.
- [ ] `pnpm check` passes.

## Blocked by

- #149
