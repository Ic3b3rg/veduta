# 131 — Bound the injected superseded FACTS tail

## Parent

#32

Repository specification:
[issues/131-bounded-superseded-facts-tail.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/131-bounded-superseded-facts-tail.md)

## What to build

Keep the complete superseded history in `FACTS.md` and in `search_memory`, but bound the superseded
records injected on every turn. Extend the shared FACTS projection to select the 20 most recently
superseded records by `supersededAt`, then include only complete rendered records that fit a 2,000
UTF-16-code-unit budget including wrappers and the omission marker.

Never slice a record. If one record alone cannot fit, omit it and count it in the marker. The marker
reports how many superseded records were omitted without copying their content. Active facts remain
governed by the watermark budget and are not silently truncated. `projectFacts` must derive both
rendered text and taint origins from exactly the records it injects; omitted records add no live
taint until an explicit `search_memory` hit dereferences them.

Preserve the full on-disk history and existing provenance-aware retrieval. Apply the shared legacy
sanitizer at render/index time, and update ADR-0006 plus the FACTS glossary entry to describe the
bounded working-set projection and on-demand recovery path.

## Acceptance criteria

- [ ] A Space with 100 superseded facts injects at most 20 complete superseded records and at most
      2,000 rendered UTF-16 code units including framing.
- [ ] Selection uses the most recent `supersededAt` values deterministically; records are never
      partially rendered.
- [ ] An oversized record is omitted, an omission marker reports the total omitted count, and the
      original remains intact and discoverable through `search_memory`.
- [ ] Injected text and `contextOrigins` come from the same selected records; omitted origins do not
      taint a turn until retrieval.
- [ ] Active, dormant, and full superseded records remain unchanged on disk, with no destructive
      forgetting.
- [ ] ADR-0006 and `CONTEXT.md` describe the bounded projection and retrieval contract.
- [ ] Boundary tests cover count, exact-size, size+1, one oversized record, ordering, provenance, and
      legacy sanitization, and `pnpm check` passes.

## Blocked by

- #128
