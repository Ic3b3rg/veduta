# Research 18 — AG-UI/A2UI with subscription-backed Model connections

> Conducted on 2026-08-26 from primary sources. “Subscription” means a paid provider account used
> as a Veduta Model connection unless a section explicitly says otherwise. External project claims
> are pinned to current revisions where possible. Statements marked **Inference** are architectural
> conclusions drawn from the cited sources, not guarantees made by those projects.

## Executive finding

**Architectural inference:** the apparent incompatibility is a layer mismatch. **AG-UI and A2UI do
not need to authenticate to ChatGPT or Claude subscriptions.** A2UI describes generated UI; AG-UI
carries interactions between an application and an Agent backend; Veduta's `AgentRunner` and Model
connection adapters decide which provider account performs inference. AG-UI's core input has
messages, state, tools, context, and an open-ended `forwardedProps`, but no standardized provider
credential, billing plan, Model connection, or authorization lifecycle.
([AG-UI architecture](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/docs/concepts/architecture.mdx),
[run input schema](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/core/src/types.ts))

**Recommended architecture (inference):**

```text
Veduta PWA and catalog renderer
  ↕ A2UI operations carried in AG-UI events
Veduta AG-UI Gateway adapter
  ↕ normalized Agent events and server-owned ToolDefs
Veduta Agent loop, trust policy, persistence, and Surface lifecycle
  ↕ AgentRunner / provider bridge
Veduta Model connection adapter
  ↕ ChatGPT subscription through Codex app-server, or BYOK provider API
Model
```

This arrangement preserves subscriptions without asking either UI standard to know about them.
It also means adopting AG-UI/A2UI would not simplify authorization, refresh, model catalogs,
provider policy, or failover. It could simplify the client-facing run and UI wire formats while
leaving those lower-layer responsibilities intact.

The concrete provider results differ:

- **ChatGPT/Codex is already sufficient.** The exact Codex 0.146.1 release Veduta pins exposes
  managed ChatGPT browser/device-code login and experimental dynamic tools. Veduta already adapts
  both behind `AgentRunner`, and its real-account smoke record plus parity suites show a ChatGPT
  subscription creating and patching validated Surfaces through the same tool contract as BYOK.
  ([pinned Codex app-server](https://github.com/openai/codex/blob/79b4f03d35962b005b007a015113b38930711665/codex-rs/app-server/README.md),
  [ADR-0016](../adr/0016-primary-agent-connections-author-surfaces.md),
  [real-account record](11-model-connections-manual-smoke.md),
  [Surface parity test](../../packages/daemon/src/subscription-surface-flow.test.ts))
- **Claude consumer subscriptions remain blocked for Veduta's intended onboarding.** AG-UI now
  has a Claude Agent SDK integration, but its documented server example uses
  `ANTHROPIC_API_KEY`, and the adapter invokes the SDK's own Agent loop. Anthropic explicitly says
  third-party developers may not offer Claude.ai login or route Free, Pro, or Max credentials for
  their users without prior approval. An AG-UI adapter changes neither rule.
  ([AG-UI Claude adapter](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/integrations/claude-agent-sdk/typescript/README.md),
  [Anthropic Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview),
  [Anthropic credential policy](https://code.claude.com/docs/en/legal-and-compliance))

**Conclusion:** subscription support is not a reason to reject an AG-UI/A2UI boundary. It is a
reason to place that boundary above Veduta's loop rather than to adopt a provider-specific AG-UI
Agent adapter. The subscription adapters should remain exactly where ADR-0014 and ADR-0016 put
them.

## Scope and source snapshots

The same word is used for three unrelated mechanisms:

1. a paid ChatGPT or Claude account used for Model inference — the primary question here;
2. subscribing an in-process observer or frontend to live Agent events;
3. a durable watch, webhook, or provider cursor that wakes the Agent outside chat.

Conflating them makes the architecture look more coupled than it is. **Inference:** the first
belongs below the Agent loop, the second at the application boundary, and the third in Veduta's
ingestion and Automation domain.

Current external snapshots are:

- AG-UI
  [`7343aa5`](https://github.com/ag-ui-protocol/ag-ui/tree/7343aa5519bab571e627335e611d2cb99e12ef88),
  whose TypeScript core/client packages report version 0.0.58
  ([package](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/core/package.json));
- A2UI
  [`2bb8423`](https://github.com/a2ui-project/a2ui/tree/2bb8423060308bbdea8ba468dabed4fc256d18ea),
  whose production protocol is v0.9.1 while v1.0 remains a release candidate
  ([status](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/README.md));
- OpenAI Codex current
  [`039eb58`](https://github.com/openai/codex/tree/039eb58a0ba6647fb8f29fdd35341f3f1b153728),
  checked in addition to Veduta's pinned 0.146.1 tag at
  [`79b4f03`](https://github.com/openai/codex/tree/79b4f03d35962b005b007a015113b38930711665).

The AG-UI integration tree was also inspected at the pinned revision. It contains Claude Agent
SDK and Claude Managed Agents integrations, but no Codex app-server integration.
([integration index](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/docs/integrations.mdx),
[integration tree](https://github.com/ag-ui-protocol/ag-ui/tree/7343aa5519bab571e627335e611d2cb99e12ef88/integrations))

## What each layer actually knows

The A2UI and AG-UI columns below summarize their published contracts; the Veduta column is the
architectural mapping inferred from the repository's domain boundaries.

| Responsibility                                      | A2UI                 | AG-UI                          | Veduta loop / Model connections                       |
| --------------------------------------------------- | -------------------- | ------------------------------ | ----------------------------------------------------- |
| Declarative component and data-model operations     | Yes                  | Carries them                   | Validates, persists, and gives them product meaning   |
| Agent run, text, tool, state, and activity events   | No                   | Yes                            | Produces and consumes them                            |
| PWA-to-Gateway authentication                       | No                   | Transport headers are possible | Owns the authenticated endpoint                       |
| Provider account login and token refresh            | No                   | No standard contract           | Owns per adapter                                      |
| Provider model catalog and selected connection      | No                   | No standard contract           | Owns registry and routing                             |
| Tool execution, trust, provenance, and Event log    | No                   | Describes tool calls only      | Owns authority and effects                            |
| Persistent Surface lifecycle across runs/reconnects | Wire operations only | Generic state/events only      | Owns identity, versions, order, replay, and lifecycle |

A2UI explicitly accepts output from any Model capable of generating JSON and names AG-UI as a
compatible transport. It does not select or invoke that Model.
([A2UI architecture and dependencies](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/README.md))

AG-UI's universal seam is an implementation of
`run(input: RunAgentInput) -> Observable<BaseEvent>`. Its `HttpAgent` sends one POST with the run
input and reads an event stream; endpoint headers are configurable, but those headers authenticate
the application request, not the Model provider behind the Agent.
([architecture](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/docs/concepts/architecture.mdx),
[`HttpAgent`](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/client/src/agent/http.ts))

Veduta already has the missing lower layer. A `ModelRef` may carry a `connectionId`; the provider
bridge routes a subscription connection to its own normalized stream rather than requiring the
model to exist in pi's built-in catalog. Both builtin and subscription transports feed the same
`AgentRunner`, whose tools have schemas, handlers, trust levels, egress declarations, and
provenance-aware execution context.
([AgentRunner](../../packages/daemon/src/agent-runner.ts),
[provider bridge](../../packages/daemon/src/pi-provider-bridge.ts),
[Model connection contract](../../packages/daemon/src/model-connection-adapter.ts))

## ChatGPT subscription: compatible without an AG-UI Codex adapter

### Explicit support

The Codex release Veduta pins provides two capabilities that matter here:

1. `account/login/start` supports managed ChatGPT browser and device-code flows; Codex persists
   and refreshes its tokens itself.
2. With `experimentalApi` enabled, `thread/start.dynamicTools` registers client-defined functions
   and turns an invocation into an `item/tool/call` request that the client answers.

Both are documented in the official 0.146.1 app-server source.
([authentication](https://github.com/openai/codex/blob/79b4f03d35962b005b007a015113b38930711665/codex-rs/app-server/README.md#auth-endpoints),
[dynamic tools](https://github.com/openai/codex/blob/79b4f03d35962b005b007a015113b38930711665/codex-rs/app-server/README.md#dynamic-tool-calls-experimental))
The current app-server retains both contracts.
([current authentication](https://github.com/openai/codex/blob/039eb58a0ba6647fb8f29fdd35341f3f1b153728/codex-rs/app-server/README.md#auth-endpoints),
[current dynamic tools](https://github.com/openai/codex/blob/039eb58a0ba6647fb8f29fdd35341f3f1b153728/codex-rs/app-server/README.md#dynamic-tool-calls-experimental))
OpenAI's current authentication documentation also names the two modes directly: ChatGPT sign-in
provides “subscription access,” while an API key provides usage-based access.
([Codex authentication](https://developers.openai.com/codex/auth))

Veduta uses exactly that seam: its Codex adapter owns authorization, account refresh, catalog,
verification, logout, and a normalized subscription inference stream. Each turn starts a restricted
Codex thread, disables provider-native tools, supplies only gated Veduta definitions through
`dynamicTools`, and returns accepted calls to `AgentRunner` for execution.
([Codex adapter](../../packages/daemon/src/model-connection-codex.ts),
[tool-turn translation](../../packages/daemon/src/codex-tool-turn.ts),
[ADR-0014](../adr/0014-subscription-inference-boundary.md))

The repository has stronger evidence than interface inspection alone. Its provider-parity suite
compares a native provider and the Codex subscription path through the same definition, call,
handler, result, session, and effect lifecycle. Its end-to-end subscription Surface test sends
`create_surface` and `patch_state` through Codex dynamic tools and observes persisted Surface and
Gateway updates. A real-account smoke on 2026-08-11 passed the same create-and-patch flow with no
OpenAI API key configured.
([generic parity](../../packages/daemon/src/provider-tool-parity.test.ts),
[Surface parity](../../packages/daemon/src/subscription-surface-flow.test.ts),
[smoke record](11-model-connections-manual-smoke.md))

### Architectural consequence

**Inference:** A2UI does not add a new subscription capability requirement. The official AG-UI
A2UI middleware represents UI generation as a `render_a2ui` tool with JSON Schema parameters,
injects it into the generic AG-UI tool list, and converts the resulting tool events into A2UI
activity events. Veduta's subscription path already round-trips arbitrary allowed tool definitions;
therefore an A2UI-generation tool can travel through the existing Codex adapter just like
`create_surface` does.
([A2UI middleware tool](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/middlewares/a2ui-middleware/src/tools.ts),
[middleware event translation](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/middlewares/a2ui-middleware/src/index.ts),
[primary connection invariant](../adr/0016-primary-agent-connections-author-surfaces.md))

There is no first-party AG-UI Codex adapter at the inspected revision. **Inference:** that matters
only if Codex itself is meant to be the AG-UI Agent. In the proposed architecture it is not: Veduta
is the Agent, and its existing `AgentRunner` is the adapter target. Writing a second direct
Codex-app-server-to-AG-UI integration would duplicate Veduta's normalization and tempt the provider
runtime to own sessions, tools, and approvals.

## Claude subscription: an adapter exists, but it solves a different problem

AG-UI's TypeScript Claude integration is technically substantial. It calls the Claude Agent SDK's
`query()` API, manages SDK sessions, maps frontend tools to an MCP server, auto-allows those tools,
and converts SDK output into AG-UI events. Its documented launch path supplies
`ANTHROPIC_API_KEY`.
([README](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/integrations/claude-agent-sdk/typescript/README.md),
[implementation](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/integrations/claude-agent-sdk/typescript/src/adapter.ts))

**Inference:** that is an Agent-runtime adapter, not a consumer-subscription bridge. Anthropic
describes the Agent SDK as providing the same loop, built-in tools, context management, sessions,
Skills, and permissions as Claude Code. Its current guidance says third-party Agent SDK products
should use API-key authentication and may not offer Claude.ai login or rate limits without prior
approval.
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview))

Anthropic's legal page adds a narrow distinction: a product may host an **unmodified Claude Code
binary** while each end user signs in through Anthropic with their own credentials, subject to the
listed commercial conditions; it still may not collect or intermediate credentials or offer
Claude.ai login inside its own application. This exception does not turn the Agent SDK integration
into a public third-party subscription OAuth contract.
([credential and hosted-binary terms](https://code.claude.com/docs/en/legal-and-compliance))

A current Anthropic Help Center notice creates an important apparent contradiction: it says Agent
SDK, `claude -p`, and third-party-app usage presently draw from a user's subscription limits. That
is explicit evidence of a technical and billing path, but it does not grant an unapproved product
permission to collect, route, or present Claude.ai credentials. The simultaneously published SDK
and legal guidance above still restricts that product flow. **Inference:** for Veduta, “can consume
subscription limits” and “may expose subscription login to users” are therefore separate tests.
([subscription-limit notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))

**Inference:** replacing Veduta's loop with the official AG-UI Claude adapter would create two
problems at once. It would import a second Agent loop that owns tools and sessions, contrary to
ADR-0014/0016, while still not authorizing Veduta's intended in-PWA Claude subscription flow.
Keeping the current unavailable gate is therefore correct until Anthropic approves the product or
publishes a suitable contract.
([Claude gate](../../packages/daemon/src/model-connection-claude.ts))

## The safe integration boundary for Veduta

### Keep below AG-UI

These remain Gateway-owned and must not be serialized into A2UI data or generic AG-UI
`forwardedProps`:

- Model connection authorization and refresh;
- credential storage and redaction;
- connection and model selection;
- catalog retrieval, eligibility, failover, and usage accounting;
- provider protocol pins and failure classification.

AG-UI's `forwardedProps` is deliberately unconstrained, while Veduta's public Model connection
schema deliberately excludes secret references and rejects unknown fields.
([AG-UI run schema](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/core/src/types.ts),
[Veduta connection schema](../../packages/protocol/src/model-connection.ts))

### Put at the AG-UI boundary

A small `VedutaAgent` adapter can translate:

- `AgentRunner` turn and text events to AG-UI run/text events;
- validated tool start/results to AG-UI tool events;
- persisted Surface updates to A2UI activity events or a narrow Veduta extension;
- Pending decisions to AG-UI interrupts where their semantics align;
- authenticated PWA actions back to existing Gateway/domain commands.

**Inference:** the adapter must accept only server-owned tools. An AG-UI `Tool` contains a name,
description, and JSON Schema, but a Veduta `ToolDef` also requires a trusted handler, L0/L1/L2,
egress domains, and live provenance. Blindly accepting frontend-provided AG-UI tools would erase
the security fields that make a tool executable in Veduta.
([AG-UI tool schema](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/core/src/types.ts),
[Veduta ToolDef](../../packages/daemon/src/agent-runner.ts),
[trust model](../SECURITY.md))

### Decide separately how native A2UI should become

Subscription compatibility is the same for either option:

1. Keep Veduta's persistent Surface model internally and project validated changes to A2UI at the
   Gateway. This is the lowest-risk interoperability spike.
2. Make A2UI the persistent Surface representation. This removes more proprietary wire format but
   requires a migration plus explicit versions, ordering, fast path, freshness, pinning, Space
   ownership, and replay semantics that A2UI itself does not define.

ADR-0003 currently chooses an A2UI-inspired mapping rather than direct conformance, so option 2 is
a new architectural decision, not a library swap.
([ADR-0003](../adr/0003-declarative-atoms.md))

## Would adoption simplify subscription support?

No. It would leave subscription support almost exactly unchanged.

| Concern                              | Effect of adopting AG-UI/A2UI above the loop                            |
| ------------------------------------ | ----------------------------------------------------------------------- |
| ChatGPT login and refresh            | None; Codex app-server and the Model connection registry still own them |
| Claude subscription availability     | None; provider policy still controls it                                 |
| Provider model catalog and routing   | None; stays behind `ModelRef` and the provider bridge                   |
| Tool parity across BYOK/subscription | Preserved if the new A2UI tool is a server-owned `ToolDef`              |
| Agent-to-PWA streaming               | Potentially simplified by AG-UI event types and clients                 |
| Generated UI wire format             | Potentially simplified by direct A2UI conformance                       |
| Persistent Home semantics            | Not supplied; Veduta must retain them                                   |

**Inference:** the worthwhile experiment is not “connect AG-UI to a ChatGPT subscription.” It is
“wrap the existing Veduta Agent loop in AG-UI, then prove the already-working ChatGPT subscription
can invoke one server-owned A2UI generation tool without any provider-specific change.” Success
criteria should include:

1. the same tool definition and accepted call through BYOK and Codex subscription;
2. no provider credential, token, or secret reference in AG-UI/A2UI frames;
3. provider-native tools still disabled;
4. the generated Surface validates, persists, reloads, and updates through fast path plus Event log;
5. changing Model connections requires no renderer or AG-UI adapter change.

If that spike passes, subscriptions are not the adoption risk. Persistence, replay, and the
current 0.x/candidate maturity of the two standards are the real decision points.

## Terminology appendix: the other two kinds of subscription

| Meaning                      | What the standards explicitly provide                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | What remains Veduta-specific                                                                                                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-process event observer    | AG-UI exposes RxJS Observables and `AgentSubscriber`; this `subscribe()` is a callback API, not a provider plan. ([subscriber docs](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/docs/sdk/js/client/subscriber.mdx))                                                                                                                                                                                                                                                                                                                                                       | None at the provider-auth layer                                                                                                                                                                                                                 |
| Live frontend stream         | The reference `HttpAgent` performs one POST and reads an SSE stream until completion or abort. Capability discovery can declare WebSocket, push notification, and resumable support, but discovery is optional and is explicitly not negotiation. ([HTTP client](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/client/src/agent/http.ts), [capabilities](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/docs/concepts/capabilities.mdx))                                                                    | Automatic reconnect, authoritative cursors, and durable Surface replay still need an implementation; Veduta currently sends a `surfaceCursor` on `hello` and reports replay count. ([Gateway protocol](../../packages/protocol/src/gateway.ts)) |
| A2UI delivery                | A2UI requires ordered, framed delivery and leaves transport choice to AG-UI, SSE/JSON-RPC, WebSocket, or another binding. ([v1 candidate transport contract](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v1_0/docs/a2ui_protocol.md#transport-decoupling))                                                                                                                                                                                                                                                                                                     | Durable identity, catch-up, conflict policy, and Surface lifecycle                                                                                                                                                                              |
| External-source subscription | AG-UI defines generic `CUSTOM` events and A2UI defines Agent-to-renderer UI messages. **Inference from those published scopes:** an implementation can carry and render an externally triggered update, but neither standard supplies provider watches, durable source cursors, deduplication, or wake-up policy. ([AG-UI events](https://github.com/ag-ui-protocol/ag-ui/blob/7343aa5519bab571e627335e611d2cb99e12ef88/sdks/typescript/packages/core/src/events.ts), [A2UI protocol](https://github.com/a2ui-project/a2ui/blob/2bb8423060308bbdea8ba468dabed4fc256d18ea/specification/v1_0/docs/a2ui_protocol.md)) | Events/timers-first proactivity, ingestion, Automation ownership, trust, and mailbox limits remain Veduta decisions. ([ADR-0005](../adr/0005-event-driven-proactivity.md), [ADR-0024](../adr/0024-pull-based-personal-mailbox.md))              |

The reconnect caveat is material but orthogonal to paid Model subscriptions. Replacing Veduta's
WebSocket envelope with AG-UI does not justify deleting its authoritative Surface cursor and
replay contract until an AG-UI transport implementation supplies equivalent semantics.
