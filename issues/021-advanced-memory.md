# 021 — Advanced memory: nightly Reflection, time-aware hybrid index

## Context

The literature-validated additions in [ref. 06](../docs/references/06-memory-research.md) and [ADR-0006](../docs/adr/0006-file-based-memory.md). Builds on the dormant tier, budget watermarks, and provenance-aware FACTS retrieval delivered in [#32](032-facts-hygiene-context-budget.md): this issue provides the offline engine that keeps the injected FACTS projection under `low` and the indexed long tail that makes on-demand retrieval fast.

## Goal

Memory goes from "correct" to "excellent" on the known weak spots (temporal, long tail, consolidation), without destructive forgetting and without extraction becoming truth.

## Tasks

- **Nightly Reflection** (sleep-time compute): a visible job (default 4:00) that, for every active Space, distills the day's Event log into summaries and generates 2-3 higher-level insights (browsable report). It is the compaction engine for the #32 budget: it consolidates and deduplicates **losslessly** (every claim, date, and origin preserved) via the AUDN Curator, and **demotes** the least-relevant still-valid facts to the `dormant` state to bring the active set under `low` — never deletes, never falsely supersedes, never hides an active fact.
- **Hybrid index** of the log and FACTS: keyword (FTS5) as the mandatory base; **fact-augmented**: extracted facts are indexed pointing at the original log line/FACTS record (the extraction indexes, the files remain the truth); rebuildable from scratch with one command. Every hit must **dereference and return the original record plus its origins** — extracted text aids matching only and is never the answer-bearing record. Embeddings are an **optional, off-by-default** layer behind this interface (local/Ollama-style, coherent with the egress allowlist), not required for acceptance.
- **Retrieval interface**: a dedicated query interface (query, time range, stable source reference, score, origins) that grows the turn's live taint on untrusted hits. Do **not** reuse `pre-filter.ts`'s `SimilarityHook` — that is a scalar pre-filter for discarding incoming events, not a retrieval seam.
- **Time-aware queries**: distinguish **recorded time** (`SpaceEvent.at`) from **effective/occurred time** (preserve `occurredAt` through the quarantined reader), and establish a global user timezone (absent from `SpaceSchema` today) so "start of June" and the 4:00 job are not deployment-timezone-dependent; extract the temporal range from the query → date filter before search.
- **Pre-compaction session flush**: hook in `ContextPolicy` — before compressing a session, a silent turn that persists what has not been saved (distinct from the #32 rendered-projection budget).
- **Index lifecycle**: stable source identities (Space/file/line + validation), boot reconciliation/cursor and stale-schema detection (a crash between log append and index update must be recoverable), and awareness that a restored disposable index may be stale.
- Evaluation: a mini-suite inspired by LongMemEval on the temporal/update/abstention categories with our own **pinned fixtures** and a **deterministic fake Reflection** in CI; measure retrieval hit IDs/order, not generated prose.

## Acceptance criteria

- "How much did I weigh at the start of June?" with 3 months of log → correct answer via time-aware search (fixture), correct across the user timezone.
- With the index deleted, it rebuilds and the same queries return the same results (identical hit IDs/order).
- After the Reflection, a fact repeated 5 times in the log appears in FACTS once, dated, **and** the active set is back under `low` with the demoted valid facts retained as `dormant` (retrievable, not deleted).
- FTS5 query p95 < 50 ms on a defined ~3-month fixture corpus (fixed event count/byte size, stated warm-up/cache state, hardware class).

## Dependencies

032, 006, 011, 016
