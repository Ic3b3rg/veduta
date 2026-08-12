# 074 — Preserve live trust decisions through a ChatGPT subscription

## Parent

#70

## What to build

Prove that a ChatGPT-subscription turn preserves the existing live trust matrix across sequential
tool calls. A clean trusted turn may execute an allowlisted L1 action, but a read whose returned
origins include Untrusted content must grow that same turn's taint before its next action. The later
L1 action must then become an Approval card, and an L2 action must always become one.

Drive both BYOK/fake and Codex/fake through the same AgentRunner scenarios. The Codex adapter only
transports tool definitions, calls, and results; `PiAgentRunner` and the existing trust wrappers
continue to own taint growth, allowlist evaluation, Approval cards, handler execution, audit
records, and session persistence.

## Acceptance criteria

- [ ] A trusted, allowlisted L1 action executes once through both Model connection methods with
      equivalent normalized events, session entries, audit record, and external effect.
- [ ] In one Codex turn, a Space read returns Untrusted origins, the live taint grows before the
      next call, and the later L1 action produces an Approval card instead of executing.
- [ ] An L2 action produces an Approval card regardless of an allowlist or otherwise trusted
      starting context.
- [ ] Approval outcomes and provenance remain in the same Surface, session, audit, and Space Event
      log paths used by BYOK.
- [ ] No trust decision or approval behavior is implemented inside the Codex adapter, and every
      accepted external-action call executes at most once.

## Blocked by

- #73
