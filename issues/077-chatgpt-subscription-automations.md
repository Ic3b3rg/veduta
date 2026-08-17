# 077 — Manage Automations through a ChatGPT subscription

## Parent

#70

## What to build

Give a ChatGPT-subscription turn the same Automation behavior as BYOK. In a focused Space, the
Agent can discover and manage the complete affected set, arm a one-shot timer, create a recurring
Automation, set its enabled state, and cancel it through the shared Space-bound ToolDefs. Preserve
visible Automation Surfaces, origin propagation, scheduler state, and Space Event log behavior.

Compare definitions, normalized events, session entries, and persistent effects through the common
provider-parity fixture. The Codex adapter must remain unaware of scheduling rules and may not
execute an Automation handler itself.

## Acceptance criteria

- [ ] Codex/fake and BYOK/fake receive equivalent gated, Space-bound Automation ToolDefs.
- [ ] A deterministic subscription turn lists the active Space's Automations without exposing an
      internal Space id, then arms a timer and creates a recurring Automation with the same visible
      Surface, scheduler record, origin, and session/tool chain as BYOK.
- [ ] Later subscription turns set enabled state and cancel an Automation exactly once, enforce
      ownership, and leave the same persistent and Space Event-log outcomes as BYOK.
- [ ] Handler errors return a sanitized tool result and do not replay a mutation through another
      Model connection.
- [ ] Automation handlers execute only through `PiAgentRunner`, exactly once per accepted call id.
- [ ] `pnpm check` passes.

## Blocked by

- #73
- #93
