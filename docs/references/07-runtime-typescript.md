# Research 07 — TypeScript agent runtime comparison

> Conducted on 2026-07-03 (sources cloned and inspected, npm/GitHub verified). Validates [ADR-0004](../adr/0004-typescript-pi-agent-core.md).
> **Fresh note**: `@mariozechner/pi-agent-core` is deprecated (last release 0.73.1, May 2026) → renamed **`@earendil-works/pi-agent-core`** (0.80.3, Jun 30 2026); repo `earendil-works/pi` (~67,400 stars, daily commits, mitsuhiko/Ronacher among the contributors).

## Comparison table

| Criterion                     | pi-agent-core (Earendil)                                                        | Vercel AI SDK v6/v7                                      | Claude Agent SDK                      | Mastra                   | LangGraph.js                  | OpenAI Agents SDK JS |
| ----------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- | ------------------------ | ----------------------------- | -------------------- |
| Fit for single-loop + workers | Excellent (`Agent`+`AgentHarness`; worker = ephemeral instance)                 | Good (`ToolLoopAgent`)                                   | Excellent but spawns CLI subprocesses | Medium (app framework)   | Poor (graph = overhead)       | Good                 |
| BYOK multi-provider           | Excellent (~35 providers, native OpenRouter, retries)                           | Excellent                                                | **No: Claude only**                   | Good (via AI SDK)        | Good                          | Partial              |
| Per-call routing              | Native (model = mutable state)                                                  | Native (`prepareStep`)                                   | No                                    | Yes                      | Verbose                       | Per-run              |
| Context compaction            | **Built-in** (`compaction/`, `transformContext`)                                | DIY                                                      | Built-in but closed                   | Evolved memory           | Primitives                    | DIY                  |
| Session persistence           | Built-in (jsonl-repo, session tree)                                             | DIY                                                      | On the CLI filesystem                 | Built-in                 | Excellent (checkpointer)      | Partial              |
| Weight                        | Lightweight                                                                     | Core is lightweight; v7 pulls toward the Vercel platform | Heavy (CLI binary)                    | Heavy                    | Medium-high                   | Lightweight          |
| Maintenance                   | Daily commits; bus factor ~85% one person; **0.x, one rename already happened** | The best; but aggressive major-version churn             | Anthropic                             | YC company, v1.0         | LangChain, TS lags the Python | OpenAI, 0.x          |
| License                       | MIT                                                                             | Apache-2.0                                               | **Proprietary**                       | Apache-2.0 (+enterprise) | MIT                           | MIT                  |
| Imposes an architecture?      | No (pure library)                                                               | No (core)                                                | Yes (it is Claude Code)               | Yes                      | Yes (everything is a graph)   | Slightly             |

## Recommendation

**Primary: `@earendil-works/pi-agent-core` (+ pi-ai).** The only one that covers the entire profile out of the box: stateful event-driven loop, compaction/branch-summarization, JSONL sessions, skills, per-call model switching, native OpenRouter/Anthropic/OpenAI, MIT, pure library. Validated in production by OpenClaw (`PiEmbeddedRunner`) in the same role. Risks: 0.x, API in flux, dominant maintainer → wrapping + pinning.

**Runner-up: Vercel AI SDK v6 (pinned, not v7).** Safer maintenance, excellent provider layer; but compaction/persistence/harness must be built, and v7 gravitates toward the Vercel platform.

Rejected: Claude Agent SDK (proprietary + Claude only → no BYOK), Mastra (invasive), LangGraph.js (superfluous graph, TS second-class), OpenAI Agents SDK (Anthropic not first-class).

## What to wrap (binding, for reversibility)

1. **`AgentRunner`**: `start(sessionId)`, `prompt(input, opts)`, `abort()`, `on(event)` — only `PiAgentRunner` imports pi.
2. **Normalized streaming events** (our own union type): never expose pi events to the PWA.
3. **`ModelRef` + our own router**: `{provider, modelId, tier: "triage"|"reasoning"}`; cross-provider failover in the router.
4. **`ToolDef` in our own format** (name, schema, handler) with an adapter toward pi's `AgentTool`: tools are the most expensive asset to rewrite.
5. **`SessionStore` behind an interface** (append/load/branch): pi's jsonl-repo today, SQLite tomorrow without touching anything else.
6. **Compaction behind a `ContextPolicy`** (feature flag on `transformContext`).

Sources: https://github.com/earendil-works/pi · https://docs.openclaw.ai/agent-runtime-architecture · https://vercel.com/blog/ai-sdk-6 · https://platform.claude.com/docs/en/agent-sdk/overview · https://github.com/mastra-ai/mastra · https://github.com/langchain-ai/langgraphjs
