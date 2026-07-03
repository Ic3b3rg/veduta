# 003 — AgentRunner: wrapper around pi-agent-core

## Context
[ADR-0004](../docs/adr/0004-typescript-pi-agent-core.md): pi is never imported directly. Wrapping interfaces defined in [ref. 07](../docs/references/07-runtime-typescript.md).

## Goal
The encapsulated agentic runtime: `AgentRunner`, normalized events, `ToolDef`, `SessionStore`.

## Tasks
- `AgentRunner` (`start/prompt/abort/on`); `PiAgentRunner` implementation on top of `@earendil-works/pi-agent-core` (pinned version)
- Our own union type for streaming events (`text-delta`, `tool-start`, `tool-result`, `turn-end`, `error`); never expose pi events outside the package
- `ToolDef` (name, zod schema, handler) + adapter to pi's `AgentTool`
- `SessionStore` behind an interface (append/load/branch); pi's jsonl-repo as the first implementation
- `ContextPolicy` that encapsulates compaction (delegates to pi via `transformContext`, behind a feature flag)
- Contract tests that do NOT import pi (they would run unchanged on a future `AiSdkRunner`)

## Acceptance criteria
- `grep -r "pi-agent-core" packages/daemon/src` returns only the `PiAgentRunner` file
- A multi-turn conversation with a fake tool call persists and resumes from `SessionStore`
- Switching models between two prompts of the same session works (prerequisite for routing, issue 010)

## Dependencies
001
