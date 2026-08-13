# 076 — Reuse Templates through a ChatGPT subscription

## Parent

#70

## What to build

Give a ChatGPT-subscription turn the same Template-reuse behavior as BYOK. In a focused Space, the
Agent can list relevant Templates, instantiate one into a new Surface with Space-specific state,
and pin a Surface to save its composition as a Template. Preserve the existing create-Surface
justification gate, Template origins, protocol validation, and Event log behavior.

Drive the behavior through the shared AgentRunner and provider-parity fixtures. Codex transports
only generic tool definitions, calls, and results; it must not learn Template or Surface business
rules.

## Acceptance criteria

- [ ] Codex/fake and BYOK/fake receive equivalent gated Template ToolDefs and produce equivalent
      normalized events and session entries.
- [ ] A deterministic subscription turn lists Templates and creates a protocol-valid Surface from
      the selected Template with the expected state and provenance.
- [ ] A subscription turn pins a Surface and persists the same Template composition, origins, and
      Space Event log records as BYOK.
- [ ] Direct Surface creation retains the existing Template-reuse justification gate under both
      Model connection methods.
- [ ] Template and Surface handlers execute only through `PiAgentRunner`, exactly once per accepted
      call id.

## Blocked by

- #73
