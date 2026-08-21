# 132 — Cap automatic Event context and memory-tool results

## Parent

#32

Repository specification:
[issues/132-event-context-tool-result-budget.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/132-event-context-tool-result-budget.md)

## What to build

Add one shared 8,000 UTF-16-code-unit rendered budget to Event records entering automatic turn
context and to model-visible results from `read_recent`, `search_log`, and `search_memory`. Count
framing, provenance labels, and omission markers. Only complete records may be rendered; never slice
an Event or FACTS record to make it fit.

Automatic context retains the existing maximum of 20 Events. Select the newest complete Events that
fit the byte-independent rendered budget, then display the selected set chronologically. Memory
tools retain their query semantics and result ordering, render complete results in that order while
they fit, and report omitted result counts. A single oversized record is omitted with safe
identifying metadata; it remains unchanged in the Event log or FACTS file and discoverable through
explicit retrieval rather than entering the turn implicitly.

Use the shared Unicode sanitizer when legacy records are rendered. Origins returned to the live
`TurnTaint` must correspond to the records whose content actually entered the model-visible result,
so omitted content cannot silently affect or evade the trust gate.

## Acceptance criteria

- [ ] Automatic Event context contains no more than 20 complete Events and no more than 8,000
      rendered UTF-16 code units including framing.
- [ ] Automatic selection keeps the newest records that fit and displays them in chronological
      order.
- [ ] `read_recent`, `search_log`, and `search_memory` each enforce the same 8,000-unit model-visible
      result cap while preserving query-result order.
- [ ] Omission markers report omitted counts without copying omitted content; an individually
      oversized record is never partially rendered or deleted.
- [ ] Rendered records and returned taint origins stay aligned for both automatic context and tool
      results.
- [ ] Legacy content is sanitized on rendering without rewriting the append-only Event log or
      changing provenance.
- [ ] Exact-cap, cap+1, oversized-record, ordering, origin, and large-payload regressions are covered,
      and `pnpm check` passes.

## Blocked by

- #128
