# 145 — Render one-series Charts from truthful Surface state

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Make `Chart` a truthful semantic Atom for the first bounded visualization contract: one line or bar series with explicit `xKey` and numeric `yKey`. Accepted chart data must render visibly, update from canonical Surface state, and survive reload. Invalid or misleading chart definitions must fail before persistence instead of producing an empty card.

Use the reported Weight Tracker failure as the end-to-end tracer: after the user says they weigh 74 kg, the persisted measurement, visible current value, history, and chart must agree. Keep this generic; do not add Health-specific parsing or templates to the mutation path.

## Acceptance criteria

- [ ] The shared `Chart` contract accepts exactly one `line` or `bar` series with explicit `xKey`, `yKey`, ordered records, and finite numeric y-values.
- [ ] Required labels, empty-state behavior, and accessible text are part of the validated semantics rather than renderer guesses.
- [ ] Invalid chart type, missing keys, malformed records, non-numeric y-values, and multiple-series input fail before Surface persistence.
- [ ] Every accepted Chart renders a visible series or its explicit truthful empty state; it cannot collapse to an empty card.
- [ ] Updating canonical Surface state updates the visible current value, history, and chart without a reload.
- [ ] The same state remains visible and internally consistent after reload and Gateway restart.
- [ ] The Italian request `mi sono pesato e sono 74 kg` results in a visible 74 kg measurement in the Weight Tracker history and chart, not only a Chat claim.
- [ ] The implementation uses generic semantic bindings and actions, with no Weight Tracker or Health-specific command parser.
- [ ] Mock-provider and real-provider tool paths use the same validated write contract.
- [ ] Protocol and catalog tests cover valid line and bar charts, explicit empty state, invalid definitions, and live updates.
- [ ] A browser test proves the 74 kg scenario through Chat, live rendering, and reload.
- [ ] `pnpm check` passes.

## Blocked by

- #142
