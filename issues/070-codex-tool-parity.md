# 070 — ChatGPT subscription tool parity through Codex dynamic tools

## Context

[ADR-0016](../docs/adr/0016-primary-agent-connections-author-surfaces.md) makes **Connection
parity** ([`CONTEXT.md`](../CONTEXT.md)) an eligibility invariant: changing provider, model, or authorization
method cannot change the Agent's Veduta capabilities. Issue 047 initially shipped the ChatGPT
subscription connection through the exactly pinned `codex app-server` 0.146.1 with a transitional
response-only inference boundary that could not carry Veduta tool definitions or calls.

That boundary contradicts the founding contract. The BYOK path already lets `pi-agent-core`
drive Veduta's validated tools through the single Agent loop; a ChatGPT subscription must reach
the same loop and persistent outcomes. The pinned app-server exposes
custom `dynamicTools` behind its experimental `experimentalApi` capability. Veduta accepts that
pinned experimental boundary, while remaining fail-closed on protocol drift and continuing to
refuse every provider-native tool.

## Goal

With a ChatGPT subscription selected, every AgentRunner flow can use the complete tool registry
allowed by its Space and trust gates — including Surface authoring, memory, Templates, scheduler,
Workers, and trust-wrapped external actions — with the same validation, execution, session,
provenance, and UI behavior as BYOK.

## What to build

- **Ground truth before production code:** outside the repository, install the exact
  `@openai/codex@0.146.1`, generate its app-server schema with experimental definitions enabled,
  initialize with `experimentalApi`, and exercise one harmless dynamic tool through a complete
  definition → call → result → final-answer round trip. Capture the exact request, response,
  notification, correlation-id, cancellation, and error shapes without printing or retaining
  credentials or account data; interrupt any unfinished turn and delete the scratch install.
  Record the sanitized findings in a durable repository reference and derive fixtures from the
  observed protocol. Do not guess a tool-result verb or payload.
- Replace the subscription transport's response-only seam with a Veduta-owned structured contract
  that carries the turn's allowed tool definitions and emits normalized text and tool-call events.
  Preserve tool-call ids, names, JSON inputs, tool-result identity, errors, and the repeated
  model-call loop. Provider protocol types stay inside the adapter; `pi-agent-core` remains behind
  `AgentRunner` and its existing approved bridge.
- Map that structured stream onto the same assistant/tool events the existing `PiAgentRunner`
  consumes for BYOK. `PiAgentRunner` remains the only owner of zod input validation, `ToolDef`
  handler execution, live taint growth, trust decisions, session persistence, and normalized
  `AgentEvent`s. The Codex adapter translates definitions, calls, and results only; it never invokes
  a handler or owns a second agent loop.
- Opt the exactly pinned app-server into `experimentalApi` and translate only the `ToolDef`s that
  survive the turn's existing Space and origin gates into `dynamicTools`. Continue using
  `approvalPolicy: 'never'`, the read-only Codex sandbox, disabled web search, and disabled native
  tools. A dynamic call is accepted only when its id and name match a tool offered for that model
  call; an unknown, duplicated, malformed, provider-native, command, patch, MCP, or web-search item
  interrupts the Codex turn and fails it closed.
- Carry tool results back through the exact provider mechanism proven by the protocol capture and
  let the normal AgentRunner loop continue until a final assistant response. Preserve aborts,
  timeouts, per-turn correlation, retry classification, and the no-silent-fallback rule. Whether a
  Codex thread must span tool-result continuation is decided by the captured 0.146.1 contract.
- Stop flattening live tool calls and results into inert prompt markers. Conversation replay may
  omit provider reasoning as today, but it must preserve the structured identity and error state
  needed for a correct follow-up after tool execution. Images remain outside this issue unless the
  captured dynamic-tool contract requires a compatible representation.
- Remove provider-specific optional-tool metadata from `@veduta/protocol`,
  `ModelConnectionAdapter`, routing helpers, `PiAgentRunner`, Gateway wiring, PWA copy, fakes, and
  tests. A primary Model connection is either fully Agent-routable or unavailable; explicitly
  tool-free calls are selected by call purpose, never by provider or authorization method.
- Keep the current Model connections lifecycle, selectors, visible state, and **Test model** action
  unchanged. This issue changes the inference capability behind a selected connection, not the
  connection-management UX.
- Add a provider-parity contract fixture that drives the same multi-step AgentRunner scenario
  through BYOK/fake and Codex/fake transports: tool definition, valid call, handler execution, tool
  result, final text, session entries, `AgentEvent`s, and persisted effect must match apart from
  provider metadata. Cover sequential tool calls, handler errors, malformed arguments, unknown
  tools, duplicate ids, mid-turn abort, timeout, capability/version drift, and extra additive
  response fields.
- Add end-to-end deterministic scenarios for `create_surface`/`patch_state`, a read whose origins
  grow the live taint before a later action, an L1 action becoming an Approval card, and
  `spawn_worker`. Assert that every Surface mutation validates through `@veduta/protocol` and every
  fast-path or Agent mutation retains its existing Event log behavior.

## Acceptance criteria

- [ ] **Surface authoring through a subscription:** in Local VPS with no provider API key, a real
      ChatGPT subscription turn inside an existing Space creates a valid Surface, patches it in a
      follow-up, streams a short confirmation, and updates the PWA live; the corresponding session
      and Space Event log contain the same tool/provenance chain as the BYOK path.
- [ ] **Full Agent capability parity:** deterministic parity tests prove ChatGPT subscription can
      reach every tool category offered to the same BYOK turn, including memory, Templates,
      scheduler, Worker spawn, and trust-wrapped actions; no provider-specific tool filter remains.
- [ ] **One execution boundary:** tool handlers execute only through `PiAgentRunner`, exactly once
      per accepted call id. The Codex adapter contains no trust decision, business mutation, Event
      log write, or nested agent loop.
- [ ] **Trust remains live:** a trusted Codex turn that reads untrusted Space content becomes
      tainted before its next tool call; L1/L2 behavior and Approval cards match the existing BYOK
      trust matrix.
- [ ] **Native tools remain impossible:** command, filesystem patch, web-search, MCP, unknown tool,
      malformed dynamic call, and capability drift fixtures all interrupt and fail closed without
      executing an effect or silently retrying through another credential. These turn-local
      refusals never change the selected Model connection's lifecycle or force reauthorization.
- [ ] **No reduced-capability route:** provider-specific optional-tool metadata and the PWA's
      reduced-capability notice no longer exist. An adapter that cannot complete the structured
      contract is not eligible for primary routing.
- [ ] **Protocol evidence:** the sanitized 0.146.1 dynamic-tool capture documents every required
      shape used by production schemas; response schemas keep required fields typed while
      tolerating unknown additive keys.
- [ ] Existing BYOK, Model connection lifecycle, selection, failover, Worker, chat, and Surface
      tests remain green, followed by `pnpm lint`, `pnpm format:check`, `pnpm typecheck`,
      `pnpm test`, and `pnpm build`.

## Out of scope

- Giving the global chat Space tools when no Space is open; [issue 052](052-global-chat-multi-space.md)
  owns selective multi-Space work.
- Redesigning Model connection states, removing **Test model**, or changing onboarding and model
  selectors.
- Enabling Codex command execution, filesystem patches, web search, MCP, approval handling, or any
  other provider-native tool.
- Delegating the Agent loop or tool execution to Codex, using pi-ai's Codex OAuth identity, or
  relaxing the exact app-server version pin.
- Adding another subscription provider or changing Claude subscription availability.

## Implementation tickets

- #71 through #76 — completed dynamic-tool transport, Surface, trust, memory, and Template slices.
- #77 — Automation parity after the focused Automation contract in #93.
- #78 — Worker parity after real Worker execution in #39.
- #79 — one explicit primary inference contract and the final provider-parity suite after all
  category slices.

## Parent completion criteria

- [ ] Issues #71 through #79 are complete.
- [ ] Every primary Model connection satisfies one shared AgentRunner tool contract.
- [ ] The full repository gate and provider-parity suites are green.

## Blocked by

- #39
