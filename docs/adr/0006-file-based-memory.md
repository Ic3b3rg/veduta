# File-based memory: files are the truth, indexes are disposable

For each Space: `FACTS.md` (curated bi-temporal facts, always injected), an append-only Event log (recent entries in context, long tail via time-aware hybrid search), `INSTRUCTIONS.md`; globally, `USER.md` and `SOUL.md`. Tabular data lives in the typed state of the Surfaces, not in memory files. The design is defensible against the academic SOTA: at personal scale, files beat or match dedicated systems (Letta "filesystem 74% vs Mem0 68.5%"; ConvoMem; MemDelta), which win only on cost/latency — already captured by "a small FACTS always injected". Evidence and benchmark wars: `docs/references/06-memory-research.md`.

Adopted grafts from the literature: bi-temporal facts with `## Superseded` (Zep/TOKI), an Add/Update/Supersede/Noop Curator on writes (Mem0), offline nightly Reflection (sleep-time compute, ~5x less compute at runtime), a time-aware index (LongMemEval), an abstention rule in SOUL ("if it's not in memory, say so").

Status: accepted

## Considered Options
- Knowledge graph (Zep/Graphiti-style): rejected — contested gains, high cost, useless below ~150 conversations per Space.
- Extraction-as-truth (Mem0-style): rejected — loses provenance, no advantage under equal conditions; extraction at most *indexes*.
- DB with a per-domain schema: rejected — rigid; structured state already lives in the Surfaces.
