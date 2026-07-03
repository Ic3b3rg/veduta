# 021 — Advanced memory: nightly Reflection, time-aware hybrid index

## Context

The literature-validated additions in [ref. 06](../docs/references/06-memory-research.md) and [ADR-0006](../docs/adr/0006-file-based-memory.md).

## Goal

Memory goes from "correct" to "excellent" on the known weak spots (temporal, long tail, consolidation).

## Tasks

- **Nightly Reflection** (sleep-time compute): a visible job (default 4:00) that, for every active Space, distills the day's Event log into summaries, proposes FACTS updates via the AUDN Curator, and generates 2-3 higher-level insights; browsable report
- **Hybrid index** of the log: keyword (FTS5) + embeddings; **fact-augmented**: extracted facts are indexed pointing at the original log line (the extraction indexes, the files remain the truth); rebuildable from scratch with one command
- **Time-aware queries**: extraction of the temporal range from the query ("last month") → date filter before the semantic search
- **Pre-compaction memory flush**: hook in `ContextPolicy` — before compressing a session, a silent turn that persists what has not been saved
- Evaluation: a mini-suite inspired by LongMemEval on the temporal/update/abstention categories with our own fixtures

## Acceptance criteria

- "How much did I weigh at the start of June?" with 3 months of log → correct answer via time-aware search (fixture)
- With the index deleted, it rebuilds and the same queries return the same results
- After the Reflection, a fact repeated 5 times in the log appears in FACTS once, dated

## Dependencies

006, 011, 016
