# 129 — Make every FACTS rewrite secret-safe and atomic

## Parent

#32

Repository specification:
[issues/129-secret-safe-atomic-facts-writes.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/129-secret-safe-atomic-facts-writes.md)

## What to build

Route every FACTS rewrite through one validated persistence helper: interactive `write_fact`,
Reflection demotion, Space merge, and any other path that rewrites `FACTS.md`. The helper must apply
the shared sanitizer from #128 before credential detection, preserve the document's complete
active/dormant/superseded records and provenance, and persist with the repository's existing
tmp/fsync/rename mechanism instead of an in-place `writeFileSync` truncation.

For an interactive `write_fact`, a recognized credential rejects the entire proposed write before
Curator comparison and persistence. Return an explicit model-visible tool error explaining that
secrets cannot be stored; do not save a `[redacted]` fact. Hidden-character-split credentials must
follow the same path after sanitization. A rejected or failed rewrite must leave the previous FACTS
file byte-for-byte intact.

Do not retain a second persistence route for merge or Reflection. The interim 1,000-character
`write_fact` input cap remains only until the dependent watermark ticket replaces it with the
rendered hard budget.

## Acceptance criteria

- [ ] All FACTS rewrite paths call one validated helper and no longer truncate `FACTS.md` in place.
- [ ] Persistence uses the existing durable tmp/fsync/rename pattern and preserves the original file
      on validation or I/O failure.
- [ ] Sanitization runs before credential detection and Curator comparison.
- [ ] A plain or hidden-character-split recognized credential causes `write_fact` to return an
      explicit error and persist no replacement or redacted fact.
- [ ] Merge, Reflection demotion, and interactive writes preserve active/dormant/superseded records,
      metadata, origins, and ordering through the shared path.
- [ ] Failure-injection and focused regression tests cover every rewrite caller, and `pnpm check`
      passes.

## Blocked by

- #128
