# Subscription limit recovery

Research and deterministic reproduction for [issue #231](https://github.com/Ic3b3rg/veduta/issues/231),
2026-10-10. The adapter remains behind [ADR-0014](../adr/0014-subscription-inference-boundary.md).

## Reproduced cause

Before this correction, the Codex `TurnError` parser retained only `message`, and the turn
coordinator classified every terminal provider error as `unreachable`. After crossing the pi
stream boundary, the router reported a failed call to the Model connection registry. The registry
persisted `failed`; the routing projection excluded the selected connection, and an empty candidate
list received the same missing-secret error as an unresolved BYOK credential. A keyless ChatGPT
subscription could therefore remain excluded even after its allowance became available.

The regression first failed with `expected 'failed' to be 'connected'` for global, focused and
System Space Chat. It uses the real Codex adapter, subscription recovery wrapper, provider bridge,
`PiAgentRunner`, `ModelRouter`, durable connection registry and routing projection with a scripted
provider transport. Sources: [lifecycle regression](../../packages/daemon/src/subscription-quota-recovery.test.ts),
[turn coordinator](../../packages/daemon/src/codex-tool-turn.ts),
[registry](../../packages/daemon/src/model-connection-registry.ts),
[routing projection](../../packages/daemon/src/model-connection-routing.ts),
[router](../../packages/daemon/src/model-routing.ts).

The authenticated Local VPS journey exposed a second boundary: global and focused Chat interpret
service requests before starting the Agent turn. Its catch replaced the typed inference failure
with a generic service-request error. The coordinator now retains sanitized known model errors,
including unavailable routing, while unexpected interpreter errors retain the generic response.
That failure remains terminal: reconnect/reload does not replay it, and a new submission can run
after availability returns. System Chat bypasses service interpretation and exercises the main
Agent path. Sources: [coordinator regression](../../packages/daemon/src/chat-timeline-coordinator.test.ts),
[authenticated browser journey](../../packages/e2e/tests/subscription-quota.spec.ts),
[external provider fixture](../../packages/e2e/tests/subscription-quota-fixture.ts).

## Pinned provider evidence

The current pin is Codex 0.160.0, whose upstream release resolves to
`a956835d020762cb2b570053af06f643a11c0ecc`. App-server v2 exposes separate `usageLimitExceeded`,
`rateLimitExceeded` and `unauthorized` values in `error.codexErrorInfo`. Unknown additive variants
must remain generic failures. Sources: [pinned error enum](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server-protocol/src/protocol/v2/shared.rs#L72-L123),
[Veduta compatibility check](codex-0.160-compatibility.md).

The provider maps usage-window exhaustion, quota exhaustion and usage not included in a plan to
`usageLimitExceeded`. The value alone does not identify which allowance, workspace credit pool or
spending restriction was reached. It maps request rate limiting separately and failed credential
refresh to `unauthorized`. Source: [core error mapping](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/error.rs#L464-L503).

`TurnError` carries no structured retry/reset time. Its human-readable message is not a timestamp
API. Structured window reset times arrive in `account/rateLimits/updated` or
`account/rateLimits/read`, with `resetsAt` expressed in Unix seconds. Rolling updates are sparse;
null windows do not erase earlier observations. Sources:
[TurnError](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs#L422-L433),
[rate-limit snapshots and windows](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L649-L777).

The full rate-limit read has a nullable `ordinaryUsageAllowed` permission. Upstream explicitly
forbids inferring recovery from percentages or elapsed reset times when that permission is unknown.
An authentication or catalog refresh likewise cannot establish inference availability. Veduta's
correction clears a reported limit only after a successful inference, and retains live provider
reset timestamps as informational evidence. It never schedules an automatic retry. Source:
[rate-limit read contract](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L328-L345).

`willRetry: true` is an intermediate error during Codex's own active turn. Veduta preserves that
behavior and waits for the terminal outcome. Source:
[error notification](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server-protocol/src/protocol/v2/notification.rs#L59-L69).

## Correction and recovery contract

Temporary usage/rate limits persist as an optional `inferenceIssue` alongside a still-connected
credential lifecycle. Chat receives the same actionable message as Model connections. A new user
message or **Test model** checks the provider again. Successful inference clears the issue; a
tool hand-off, account refresh, elapsed reset timestamp or UI reload does not. Auth failures retain
their canonical reconnect flow. Empty setup, unavailable selection and missing BYOK credentials
have separate router messages. Sources:
[shared schema](../../packages/protocol/src/model-connection.ts),
[normalization](../../packages/daemon/src/codex-inference-error.ts),
[recovery wrapper](../../packages/daemon/src/connection-inference.ts),
[connection copy](../../packages/pwa/src/model-connection-view.ts).

For existing installations, boot repairs only a failed Codex record carrying known upstream
quota or rate-limit wording. The matcher is deliberately limited to that pinned wording; it does
not reinterpret unknown messages, revoked/expired states, or BYOK records. It preserves selection,
credential references and provider-owned credential files, and never parses reset times from old
prose. Sources: [historical provider wording](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/error.rs#L692-L812),
[rate-limit wording](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/protocol/src/error.rs#L102-L104),
[boot repair and regression](../../packages/daemon/src/model-connection-registry.test.ts).

Quota and rate-limit errors stop the original turn without automatic replay or switching provider.
Existing explicitly enabled fallback behavior for other eligible failures remains unchanged;
neither a paid BYOK connection nor mock becomes an implicit fallback. A regression also exhausts
quota after one accepted tool effect and verifies one handler call, zero fallback calls and no
effect replay. Sources: [failover regression](../../packages/daemon/src/subscription-failover.test.ts),
[existing fallback policy](../../packages/daemon/src/model-connection-routing.ts).

The deterministic fixtures exercise exhaustion, a second still-limited user turn, registry
recreation/reload and successful recovery. They do not establish that the owner's actual provider
allowance had reset when the original report was made, and do not consume or alter a real account.

## Manual UI verification

1. With the selected subscription limited, send a message in global, focused or System Space
   Chat. Confirm the reply names the subscription usage limit and directs recovery through a new
   message or **Test model**, without a missing-secret diagnosis.
2. Open **Settings → Models** and select the account. Confirm the same reason appears, the account
   remains connected, and the selected model remains available for testing. Provider reset times
   appear only if reported by the provider.
3. Reload the page. Confirm the terminal Chat error and connection feedback remain visible.
4. After provider availability recovers, send a new message or use **Test model**. Confirm success
   clears the connection feedback and does not replay the earlier request.
5. Separately force genuine revoked authorization. Confirm reconnect remains required and later
   messages retain that reason rather than a missing-secret error.
