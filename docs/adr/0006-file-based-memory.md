# File-based memory: files are the truth, indexes are disposable

For each Space: `FACTS.md` (curated bi-temporal facts, always injected), an append-only Event log (recent entries in context, long tail via time-aware hybrid search), `INSTRUCTIONS.md`; globally, `USER.md` and `SOUL.md`. Tabular data lives in the typed state of the Surfaces, not in memory files. The design is defensible against the academic SOTA: at personal scale, files beat or match dedicated systems (Letta "filesystem 74% vs Mem0 68.5%"; ConvoMem; MemDelta), which win only on cost/latency — already captured by "a small FACTS always injected". Evidence and benchmark wars: `docs/references/06-memory-research.md`.

Adopted grafts from the literature: bi-temporal facts with `## Superseded` (Zep/TOKI), an Add/Update/Supersede/Noop Curator on writes (Mem0), offline nightly Reflection (sleep-time compute, ~5x less compute at runtime), a time-aware index (LongMemEval), an abstention rule in SOUL ("if it's not in memory, say so").

The Curator treats topic proximity only as a candidate lookup. It retires an active fact only when
it establishes a contradiction or when `write_fact` explicitly names that fact through
`supersedes`; an unknown explicit target fails. This keeps `## Superseded` equivalent to "no longer
true" without guessing that two values on the same topic represent one claim. The full rationale is
recorded in [issue 034](../../issues/034-curator-false-supersede.md).

Status: accepted

## Amendment (issue 021): the `dormant` state, and a working set

FACTS has three states, not two: `active | dormant | superseded`. **Dormant** is a valid fact,
kept on disk, **not injected** into context, and retrieved on demand. It is not superseded —
nothing replaced it — and it is never deleted, so it is not destructive forgetting.

The model is a working set with demand paging: the injected projection is the hot set, bounded by
the `low` watermark measured over the **rendered** active text, and the nightly Reflection is the
compaction pass that brings it back under that bound by demoting the least-recently-noted still-valid
facts. Files remain the truth; the demoted long tail is reached through the disposable index
described in [ADR-0011](0011-disposable-hybrid-index.md), which also records why demotion carries no
recency veto and no floor, and how the Reflection consolidates losslessly without ever falsely
superseding.

One consequence worth stating here: because FACTS is a read model over an append-only log, the
guarantee that "every claim, date and origin is preserved" is a property of the **Event log**, not of
`FactRecord`. A fact carries one date and one origin; the log carries the whole trail, and a
`fact.evidence` entry keeps that trail growing even when the Curator answers `noop`.

## Considered Options

- Knowledge graph (Zep/Graphiti-style): rejected — contested gains, high cost, useless below ~150 conversations per Space.
- Extraction-as-truth (Mem0-style): rejected — loses provenance, no advantage under equal conditions; extraction at most _indexes_.
- DB with a per-domain schema: rejected — rigid; structured state already lives in the Surfaces.
