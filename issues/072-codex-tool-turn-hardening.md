# 072 — Harden Codex tool turns for correlation and protocol drift

## Parent

#70

## What to build

Make the structured Codex tool path fail closed before it is eligible for primary Agent routing.
Track each offered tool set and accepted call for one model call, preserve thread/turn/tool-call
correlation, and guarantee at-most-once handler execution. A call is accepted only when its name
was offered for that call and its call id is fresh and correctly correlated.

Exercise repeated calls in one Codex turn and carry ordinary handler failures back as sanitized
`success: false` tool results so the Agent can continue to a final response. Treat malformed
arguments, unknown names, duplicate ids, correlation mismatches, invalid namespaces, malformed
provider responses, and capability/version drift as protocol violations that interrupt the turn
without an effect. Continue to reject every provider-native command, filesystem patch, MCP, and
web-search item while retaining approval policy `never`, the read-only sandbox, and disabled
provider tools.

Preserve abort and timeout behavior through `turn/interrupt`; a late tool result must not revive an
interrupted turn. Once an accepted call may have executed, an error must not silently retry through
another Model connection or replay the effect.

## Acceptance criteria

- [ ] Deterministic fixtures cover sequential accepted calls, a handler error followed by final
      assistant text, malformed arguments, unknown tools, duplicate call ids, and thread/turn/call
      correlation mismatches.
- [ ] Command, filesystem-patch, MCP, web-search, and other provider-native items interrupt the
      Codex turn without invoking a Veduta handler.
- [ ] Mid-turn abort and timeout interrupt promptly; an in-flight call receives no fabricated
      completion, and a late response cannot resume the turn or execute another effect.
- [ ] Capability/version drift and missing required response fields fail the connection closed,
      while unknown additive response fields remain compatible.
- [ ] No invalid scenario executes an effect or silently retries through another credential, and
      every accepted call id executes at most once.

## Blocked by

- #71
