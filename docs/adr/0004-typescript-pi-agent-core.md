# TypeScript everywhere; pi-agent-core runtime wrapped behind our own interfaces

Monorepo entirely in TypeScript (the PWA has to be; one language = one contributor can touch everything; the maintainer is TS-first). Agent runtime: **`@earendil-works/pi-agent-core`** (formerly `@mariozechner/pi-agent-core`, renamed June 2026) — the only candidate with a stateful loop, compaction, persistent sessions, ~35 BYOK providers and per-call model switching out of the box, MIT-licensed, validated in production by OpenClaw in the exact same role. Full comparison: `docs/references/07-runtime-typescript.md`.

Accepted risk: 0.x version, bus factor ~85% on one person. Binding mitigation: **pi is never imported directly** — only behind `AgentRunner`, normalized streaming events, `ModelRef` (our own triage/reasoning router), `ToolDef`, `SessionStore`. Plan B: Vercel AI SDK v6 (migration estimated at ~1 week thanks to the wrapping).

Status: accepted

## Considered Options
- Fork of OpenClaw: rejected — 21k files with a chat-first center of gravity opposite to our thesis.
- Fully from scratch: rejected — months spent on already-proven wheels instead of on the differentiator.
- Claude Agent SDK: rejected — proprietary license, Claude models only, incompatible with BYOK.
- Mastra / LangGraph.js: rejected — intrusive framework / a graph is superfluous for a single loop.
