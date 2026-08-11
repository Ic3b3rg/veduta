# 071 — Round-trip one Codex dynamic tool through AgentRunner

## Parent

#70

## What to build

Complete one deterministic ChatGPT-subscription tool round trip through the existing AgentRunner boundary: offer one harmless L0 `ToolDef`, receive its Codex dynamic call, validate and execute it exactly once in `PiAgentRunner`, return its result through the same provider turn, and receive the final assistant response.

Promote the sanitized `@openai/codex@0.146.1` prototype findings into a durable repository reference and derive the adapter fixtures from those observed shapes. The captured contract initializes with `experimentalApi`, sends `dynamicTools` at thread start, receives an `item/tool/call` server request, keeps the reverse JSON-RPC request id separate from the semantic tool-call id, responds on that request id with `success` and `contentItems`, and then lets the same Codex turn continue. Required fields remain typed while unknown additive fields are tolerated.

Replace the text-only subscription seam with a Veduta-owned structured turn contract carrying allowed tool definitions and normalized text/tool-call events. Provider protocol types remain inside the adapter. The adapter translates definitions, calls, and results only; zod validation, handler execution, trust context, session persistence, and normalized `AgentEvent`s remain owned by `PiAgentRunner`. Keep the current primary-routing capability gate in place until the fail-closed hardening slice is complete.

## Acceptance criteria

- [ ] A durable sanitized reference documents the observed 0.146.1 definition, call, result, final-response, correlation, cancellation, and error shapes used by production schemas.
- [ ] A deterministic Codex fake completes definition → call → validated handler → result → final text through one Codex turn, and the handler executes exactly once.
- [ ] The same scripted scenario through BYOK/fake and Codex/fake produces equivalent session entries, normalized `AgentEvent`s, and persisted effect apart from provider metadata.
- [ ] The Codex transport handles reverse server requests without confusing their request ids with outbound request ids or semantic tool-call ids.
- [ ] No provider type, tool handler, trust decision, or business mutation escapes into the subscription adapter, and primary Model connection behavior remains unchanged in this slice.

## Blocked by

None - can start immediately.
