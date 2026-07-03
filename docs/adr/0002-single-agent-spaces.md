# A single agent loop: hierarchy lives in the data (Spaces), not in agents

The original idea called for a hierarchy (orchestrator → division heads → teams). We decide instead: **a single Agent** with namespaced memory (Spaces), **ephemeral Workers** only for asynchronous "investigate-and-report" tasks, adversarial review only on high-risk asynchronous outputs and in a separate context, and per-call model routing instead of "senior/junior" agents.

Rationale: the 2024-2026 evidence is clear-cut — every handoff loses information (Data Processing Inequality, arXiv:2604.02460), hierarchical systems fail 41-87% of tasks (MAST, arXiv:2503.13657), error compounding penalizes every mandatory step on the synchronous path, and a personal assistant is latency-sensitive with heavily shared context (the very case even Anthropic excludes from multi-agent). Full evidence: `docs/references/03-single-vs-multi-agent.md`.

Status: accepted

## Consequences
- Isolation per life area is achieved through memory (Spaces), not through dedicated agents.
- The synchronous path must stay as short as possible; everything else goes async (Workers, jobs).
- If deep multi-source research were to become dominant, Anthropic's orchestrator-worker pattern is compatible: those are fan-out Workers, not persistent roles.
