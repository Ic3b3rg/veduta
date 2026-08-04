# TypeScript everywhere; pi-agent-core runtime wrapped behind our own interfaces

Monorepo entirely in TypeScript (the PWA has to be; one language = one contributor can touch everything; the maintainer is TS-first). Agent runtime: **`@earendil-works/pi-agent-core`** (formerly `@mariozechner/pi-agent-core`, renamed June 2026) — the only candidate with a stateful loop, compaction, persistent sessions, ~35 BYOK providers and per-call model switching out of the box, MIT-licensed, validated in production by OpenClaw in the exact same role. Full comparison: `docs/references/07-runtime-typescript.md`.

Accepted risk: 0.x version, bus factor ~85% on one person. Binding mitigation: **pi is never imported directly** — only behind `AgentRunner`, normalized streaming events, `ModelRef` (our own triage/reasoning router), `ToolDef`, `SessionStore`. Plan B: Vercel AI SDK v6 (migration estimated at ~1 week thanks to the wrapping).

Status: accepted

## Considered Options

- Fork of OpenClaw: rejected — 21k files with a chat-first center of gravity opposite to our thesis.
- Fully from scratch: rejected — months spent on already-proven wheels instead of on the differentiator.
- Claude Agent SDK: rejected — proprietary license, Claude models only, incompatible with BYOK.
- Mastra / LangGraph.js: rejected — intrusive framework / a graph is superfluous for a single loop.

## Amendment (issue #37)

The wrapper layer is now a pair, not a single file: `pi-agent-runner.ts` (the `AgentRunner`
implementation itself) and `pi-provider-bridge.ts` (model routing's counterpart — maps a routed
`ModelRef` onto pi's provider clients via `resolveModel`/`getApiKey`/`streamFn`). Both wrap
`@earendil-works/pi-agent-core`; `pi-provider-bridge.ts` additionally wraps
`@earendil-works/pi-ai`, the provider-catalog/stream package pi-agent-core itself builds on
and re-exports pieces of (`streamSimple`, the faux/mock provider machinery). `pi-ai` is now a
direct, exactly-pinned dependency of `packages/daemon` for that reason, not merely a transitive
one.

The containment this ADR describes is enforced mechanically, not by convention: every source
file under `packages/daemon/src` is scanned for imports of `@earendil-works/pi-agent-core` or
`@earendil-works/pi-ai`, and only `pi-agent-runner.ts` / `pi-provider-bridge.ts` may import them
unrestricted (their respective test files may import pi's _types_ only, via `import type`) —
see `packages/daemon/src/import-boundary.test.ts`. Issue 003 held this boundary with a manual
grep during review; it is now a standing test that fails the build.
