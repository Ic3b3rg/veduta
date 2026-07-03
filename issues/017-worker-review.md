# 017 — Background Workers + separate adversarial review

## Context
[ADR-0002](../docs/adr/0002-single-agent-spaces.md) and MAST cautions in [ref. 03](../docs/references/03-single-vs-multi-agent.md).

## Goal
Asynchronous "investigate-and-report" work with discipline: briefing, budget, termination, review.

## Tasks
- `spawn_worker(briefing)` tool: the briefing is structured and mandatory (goal, output format with schema, allowed tools, boundaries, token budget, max iterations 5-8)
- Execution on `AgentRunner` in an isolated session; the Worker reports only to the main loop (never worker-to-worker); schema-validated delivery
- **Adversarial review in a separate context** for high-risk output (flag in the briefing): a second, fresh LLM pass with the mandate to refute/correct before delivery into the Space
- Visible state: an active Worker is an ephemeral Surface in the Space ("researching X, ~N min") with cancel
- Budget enforcement: tokens/iterations exceeded → terminate with a partial delivery, marked as such

## Acceptance criteria
- "Research the ketogenic diet for me for a week" → Worker spawns, chat stays responsive, the report lands on a Surface with the review passed
- A Worker that blows its budget terminates cleanly with partial output marked as such
- The review rejects a report with unsupported claims (fixture) → the Worker receives the feedback and corrects or delivers with a caveat

## Dependencies
003, 006, 010
