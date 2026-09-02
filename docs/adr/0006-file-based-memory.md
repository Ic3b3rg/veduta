# File-based memory: files are the truth, indexes are disposable

For each Space: `FACTS.md` (curated bi-temporal facts whose bounded working set is injected), an append-only Event log (recent entries in context, long tail via time-aware hybrid search), `INSTRUCTIONS.md`; globally, `USER.md` and `SOUL.md`. Tabular data lives in the typed state of the Surfaces, not in memory files. The design is defensible against the academic SOTA: at personal scale, files beat or match dedicated systems (Letta "filesystem 74% vs Mem0 68.5%"; ConvoMem; MemDelta), which win only on cost/latency — already captured by a small FACTS working set injected on each turn. Evidence and benchmark wars: `docs/references/06-memory-research.md`.

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

## Amendment (issue 131): bounded superseded working set

The active FACTS projection remains complete and governed by its rendered-text watermarks; this
projection never silently truncates an active record. The `## Superseded` history is also complete
on disk, but only a bounded tail is injected on every turn. The projection considers the 20 records
with the most recent `supersededAt` values, puts missing dates last, and uses file order to break
ties. It then renders those candidates newest first, including only complete records that fit a
2,000 UTF-16-code-unit tail budget. The budget includes the `Superseded:` framing, untrusted-data
wrappers, record separators, and the content-free omission marker. A candidate that does not fit is
skipped without preventing a smaller, older candidate from fitting; no record is ever sliced.

Omitted records are not forgotten. They remain unchanged in `FACTS.md`, remain indexed by the
disposable hybrid index, and are recovered by `search_memory`, which dereferences the original
record. The injected text and context origins come from the same selected records, so an omitted
untrusted record does not taint a turn until retrieval returns it with its origin. The shared
forbidden-Unicode sanitizer applies when legacy FACTS are read for projection and indexing and
again at the common fact renderer, without rewriting the source file. The executable contract is
specified in [issue 131](../../issues/131-bounded-superseded-facts-tail.md).

## Amendment (issue 132): bounded model-visible Event and retrieval records

The append-only Event log remains complete, but its automatic turn projection is bounded. It
scans Events from newest to oldest, greedily selects at most 20 complete rendered records under an
8,000 UTF-16-code-unit budget, and displays the selected records chronologically. An oversized
Event is skipped so an older complete Event can still enter the working set. The budget includes
the Recent Event log heading, record framing, provenance labels, untrusted-data wrappers, and any
omission marker. A record is never sliced to fit, and the marker counts every Event outside the
selected working set.

The model-visible results of `read_recent`, `search_log`, and `search_memory` use the same 8,000-unit
budget. They retain their query semantics and result order, skip a complete result that does not
fit, continue with later results that do, and report a content-free omission count plus safe
identifying metadata for the first omission. The original Event or FACTS record stays unchanged and
retrievable. Rendering and origin selection are one projection, so only content that actually
entered the turn contributes to its live taint. Legacy records pass through the shared forbidden
Unicode sanitizer at render time; the append-only source is never rewritten.

## Considered Options

- Knowledge graph (Zep/Graphiti-style): rejected — contested gains, high cost, useless below ~150 conversations per Space.
- Extraction-as-truth (Mem0-style): rejected — loses provenance, no advantage under equal conditions; extraction at most _indexes_.
- DB with a per-domain schema: rejected — rigid; structured state already lives in the Surfaces.
