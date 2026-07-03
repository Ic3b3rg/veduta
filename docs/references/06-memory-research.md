# Research 06 — File-based memory vs the academic SOTA

> Conducted on 2026-07-03 on request ("make sure there are no better solutions"). Validates [ADR-0006](../adr/0006-file-based-memory.md).

## Verdict

**The file-based Spaces design is defensible — and at personal scale it is probably the right choice.** The "fancy" systems (Mem0, Zep) have contested accuracy advantages and often poorly-run benchmark artifacts; simple baselines are competitive or superior; the real advantage of dedicated systems is cost/latency, already captured by "a small FACTS always injected + the long tail via search".

Where the bare design would lose: (1) temporal reasoning/knowledge-update (the worst category on LongMemEval for everyone); (2) associative multi-hop queries over thousands of events; (3) abstention ("I don't know") — a systematic failure unless instructed.

## Evidence in favor of files

- **Letta itself** (a hierarchical-memory vendor) measures: an agent with simple filesystem operations = **74.0%** on LoCoMo vs Mem0-graph at 68.5% ([blog](https://www.letta.com/blog/benchmarking-ai-agent-memory/)). What matters is the agentic ability to search, not specialized retrieval.
- **ConvoMem** ([arXiv:2511.10523](https://arxiv.org/html/2511.10523v1)): below ~150 conversations, simple approaches score 70-82% where Mem0 scores 30-45%; RAG is needed beyond that, for cost/latency, not accuracy.
- **MemDelta** ([arXiv:2606.29914](https://arxiv.org/html/2606.29914v1)): controlling for confounds, Mem0's advantage over a trivial verbatim RAG disappears and reverses.
- **Benchmark wars**: Zep shows Mem0 ran Zep badly; Mem0 shows Zep's 84% was inflated by ~25pt (corrected: 58.44%); the MemGPT team disputes the MemGPT execution. LoCoMo is synthetic, ~9-16k tokens, <100 samples/category. No "beats files" claim holds up.

## Where the academic systems are right (grafts adopted)

- **Zep/Graphiti** ([arXiv:2501.13956](https://arxiv.org/abs/2501.13956)): the **bi-temporal** model (validity + ingestion) is the right idea → dated facts + `## Superseded` in FACTS.md.
- **Mem0** ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)): the solid result is p95 of 1.44s vs 17.12s and −90% tokens; the **AUDN** operator (Add/Update/Delete/None) is a good pattern → a Curator on write.
- **Sleep-time compute** ([arXiv:2504.13171](https://arxiv.org/html/2504.13171v1), Letta/Berkeley): offline reflection → up to ~5x less compute at runtime. Validates OpenClaw's "dreaming" → nightly Reflection as a visible job. Also RMM ([arXiv:2503.08026](https://arxiv.org/abs/2503.08026)).
- **LongMemEval** ([arXiv:2410.10813](https://arxiv.org/abs/2410.10813), ICLR 2025): fact-augmented key expansion + time-aware query expansion = the highest measured gains → a time-aware hybrid index on top of the files (disposable index, files as the truth).
- **TOKI** ([arXiv:2606.06240](https://arxiv.org/pdf/2606.06240)): bitemporal resolution of contradictions; decay of _priority_, not deletion.
- **Abstention**: an explicit rule in SOUL ("if it's not in memory, say so") — the most-failed category, for free.

## What NOT to build

- **Knowledge graph** (Graphiti/Neo4j): contested gains, high ingestion cost, useless at personal scale. Reconsider only with real multi-hop queries over thousands of entities.
- **Extraction as the source of truth** (Mem0-style): you lose provenance; the advantage is nonexistent under equal conditions. Extraction at most indexes.
- **Destructive forgetting**: supersede and archive, never delete.
- **Trained "smart" retrieval**: the 2026 literature is full of acronyms without replications. Hybrid keyword+embedding + an agent that knows how to grep = a baseline nobody convincingly beats.
- **Optimizing for LoCoMo**: use LongMemEval/ConvoMem on the temporal/update/abstention categories for self-evaluation.
