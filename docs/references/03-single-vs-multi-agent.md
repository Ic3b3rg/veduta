# Research 03 — Single-agent vs multi-agent hierarchies: the evidence

> Conducted on 2026-07-02, with an explicit instruction to also look for contrary evidence. Validates [ADR-0002](../adr/0002-single-agent-spaces.md).

## Verdict

The 2024-2026 evidence clearly supports: a single main loop + namespaced memory + ephemeral workers + targeted adversarial review. A deep hierarchy of persistent agents is the configuration with the worst evidence profile: high failure rates, 5-15x costs, double latency, no benefit on tasks with shared dependencies — the exact nature of a personal assistant's work.

## In favor

1. **Cognition, "Don't Build Multi-Agents"** (Walden Yan, 2025) — https://cognition.com/blog/dont-build-multi-agents. "Share full agent traces, not just messages"; "actions carry implicit decisions". Single-threaded agent + compression. Admitted exception: subagents for isolated investigative sub-tasks that report back and do not decide (= our workers).
2. **MAST, "Why Do Multi-Agent LLM Systems Fail?"** (UC Berkeley, arXiv:2503.13657, best paper track NeurIPS 2025) — 1,600+ traces, 7 frameworks: failures at 41-86.7%. 14 failure modes: ~42% specification/design, ~37% inter-agent misalignment (context lost in handoffs, step repetition 15.7%), ~21% weak verification. More layers = more failure surface.
3. **Tran & Kiela (Stanford), arXiv:2604.02460** (2026) — at equal token budget, a single agent matches or beats multi-agent almost everywhere. Theoretical argument: the Data Processing Inequality — every handoff can only lose information.
4. **Error compounding** — 95% per-step → 59% after 10 steps; 90% → 35%. Every hierarchical layer adds mandatory steps to every request. Plus self-conditioning on errors in the context.
5. **Namespaced memory = an established pattern** — MemGPT/Letta memory blocks, LangGraph Store with tuple namespaces, Mem0 scoping. Spaces are an instance of it.
6. **RouteLLM** (LMSYS, arXiv:2406.18665) — 95% of GPT-4 quality with 14% of requests going to the large model, −85% cost: capability differentiation is done with per-call routing, not with "senior/junior" agents.
7. **Adversarial review: only in a separate context.** Self-correction without external feedback worsens results (Huang et al. 2023; arXiv:2606.05976); cross-context review gives **+11pp** on critical errors (arXiv:2603.12123).
8. **2026 production retrospectives on CrewAI/AutoGen** — state corrupted mid-pipeline, loops on tool calls, `max_iter` as a 5-10x cost driver; recurring advice: skip multi-agent for linear pipelines.

## Against (where multi-agent genuinely wins)

1. **Anthropic, multi-agent research system** (2025) — https://www.anthropic.com/engineering/multi-agent-research-system. Orchestrator (Opus) + subagents (Sonnet) beats single Opus by **90.2%** on breadth-first research. Cost ~15x; 80% of the variance is explained by tokens spent. Their own delimitation: "domains with shared context or many dependencies between agents are not suitable" → the personal assistant falls right there. The winning case = our fan-out workers.
2. **"More Agents Is All You Need"** (arXiv:2402.05120) — sampling-and-voting ensemble on the *same* task, not a hierarchy of roles. If anything, it justifies voting inside a worker on hard decisions.

## Design cautions (constraints adopted)

- Workers only for tasks that are (a) parallelizable and read-heavy, (b) worth 4-15x tokens, (c) "investigate and report" with no implicit decisions.
- Detailed briefings (goal, format, tools, boundaries): poor specification is the #1 cause of MAST failures.
- A handoff is loss, always: pass compressed context that is complete in its decisions; workers report to the loop, never worker-to-worker.
- Compression, not hierarchy, for long tasks.
- Reviewer in a separate context, only on high-risk output.
- Explicit budgets and termination (cap of 5-8 iterations, schema-validated output; "unaware of termination" = 12.4% of MAST failures).
- Count the steps: 0.95^n — keep the synchronous path short, the rest goes async.
