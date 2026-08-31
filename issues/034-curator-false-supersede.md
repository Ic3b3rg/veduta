# 034 — Curator supersedes on topic similarity alone, with no contradiction established

## Context

`curateFact` (`packages/daemon/src/facts.ts`) decides an incoming fact is _related_ to an active one
by comparing a **topic key** — the first two non-stopword words of each text — and then replaces the
active record, pushing it into `## Superseded`. `contradicts()` is consulted only to choose the label
(`supersede` vs `update`); it does **not** gate whether the previous fact is retired.

So two facts that are both true, and that contradict nothing, evict each other:

```
write_fact("gym membership expires in June")   -> active
write_fact("gym membership costs 40 euro")     -> topic key "gym membership" matches
                                               -> "expires in June" moves to ## Superseded
```

The first fact is now marked as replaced by a fact that did not replace it. It stops being injected
into context, and the Agent reads it as historical.

## Goal

`## Superseded` means "no longer true". Marking a still-true fact as superseded is a silent memory
corruption: nothing is deleted, so the never-delete rule does not catch it, but the fact is demoted
out of context and mislabelled. [ADR-0006](../docs/adr/0006-file-based-memory.md) adopts bi-temporal
supersession from the literature deliberately — it only works if supersession means supersession.

## Scope note

Found while implementing [#21](021-advanced-memory.md). The nightly Reflection must never falsely
supersede — it feeds model-extracted facts through the Curator in bulk, which would amplify this — so
#21 initially added and used a **conservative** Curator mode (exact dedupe, reactivate, add only) for
the Reflection. The interactive `write_fact` path was left **unchanged** on purpose: changing it
changes user-visible memory behaviour and deserves its own review rather than riding along inside
another issue. Recorded in [ADR-0011](../docs/adr/0011-disposable-hybrid-index.md).

## Tasks

- Make retirement conditional on an established contradiction rather than on topic proximity:
  - `contradicts()` true → `supersede` (current behaviour, correct).
  - Same normalized text → `noop` (current behaviour, correct).
  - Topic-related but not contradictory → **add**, keeping both active. Today this is `update`, which
    retires the previous fact.
- Decide the **refinement** case explicitly. A genuine refinement of the same claim ("I weigh 82kg" →
  "I weigh 80kg") is topic-related and is not caught by `preferencePolarity`'s like/dislike word
  lists, so under the rule above both would stay active. Options: a value-level comparison, or an
  explicit `supersedes` argument on `write_fact` so the writer states the intent instead of the
  Curator guessing it. Pick one and record why.
- Consider whether the conservative mode introduced by #21 becomes the only mode once the default is
  fixed, and delete the option if it does — two modes that agree are one mode.

## Implementation decision

Refinements use an explicit optional `supersedes` argument on `write_fact`. Its value identifies the
exact active fact text the new fact replaces, after the Curator's existing text normalisation. An
unknown or stale target fails the write instead of silently adding a conflicting claim.

A value-level heuristic was rejected because a changed number does not establish that two facts are
the same claim: a current weight, target weight, and historical weight can legitimately share a
topic. Writer-declared replacement intent is deterministic and reviewable. Topic proximity now only
narrows the search for an established contradiction; without a contradiction or explicit target,
both facts remain active. The Reflection uses this same Curator contract, so the separate
`conservative` mode is removed.

## Acceptance criteria

- Two non-contradicting facts sharing a topic key both remain active.
- A genuine contradiction still supersedes, with the date and the `by:` pointer intact.
- A restatement of the same fact is still a `noop`.
- The refinement case has a decided, tested behaviour rather than an accidental one.
- `packages/daemon/src/facts.test.ts` covers each of the four.

## Blocked by

None — builds on completed issues #6 and #21.
