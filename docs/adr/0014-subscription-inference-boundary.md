# Subscription-backed models stay behind the AgentRunner boundary

Veduta may use Claude Code and Codex subscriptions through provider credentials or wrapped inference adapters, but the single Agent loop continues to own tool execution, trust enforcement, Event log writes, and Surface changes. We do not delegate Agent turns to the Claude Code or Codex applications: accepting the extra adapter work keeps behavior and security independent of the selected Model connection instead of allowing provider-side behavior to bypass Veduta's architectural boundaries.

The official Claude subscription path is a Gateway-managed Claude Code/Agent SDK inference adapter with its tools disabled; the official Codex subscription path uses refreshable ChatGPT OAuth credentials. Both sit behind the same Model connection interface and expose the same connection lifecycle to the PWA. Provider-specific authentication and refresh mechanics do not become different onboarding journeys.

The Gateway owns a provider-extensible Model connection registry. The PWA renders connection choices and the shared authorize, verify, connected, expired, and recovery states from registry metadata and protocol events rather than hardcoding Claude- or ChatGPT-specific flows. Claude and ChatGPT are the initial adapters; adding providers such as Gemini, Grok, or OpenRouter must not require a new onboarding architecture.

Model connections are Gateway-wide and shared by every Space. Per-Space credentials or routing overrides are outside this initial design.

Each Model connection is an independently identified instance rather than a singleton keyed by provider. Multiple accounts for the same provider may coexist, while onboarding still requires only one working connection; account pools and ordering stay in the post-onboarding connection settings.

The Agent may inspect and change routing among already-authorized Model connections at the user's request. Adding, reauthorizing, revoking, or removing credentials always crosses into the authenticated PWA connection flow; secrets and authorization codes never enter chat or the LLM context.

The Gateway refreshes credentials automatically and may fail over only to another connection the user has already authorized and enabled for fallback. It never crosses implicitly from a subscription to metered BYOK and never hides an unavailable real connection by answering through the mock provider. When no permitted connection can serve a turn, the turn stops with a visible reconnection action; every provider change is surfaced and recorded.

Only an authentication, credential-refresh, or provider-transport failure may change a Model
connection's lifecycle. A turn-local validation, trust, or provider-native-tool refusal fails that
turn but leaves the connection connected: reauthorization cannot repair a rejected Agent action.
A connection-bound model whose live runtime is absent fails closed as unavailable and is never
reinterpreted through pi-ai's built-in model catalog.
Primary-route contract eligibility is orthogonal to credential lifecycle: an ineligible adapter
contributes no routing candidate and rejects route-dependent operations without synthesizing a
credential failure state.
On boot, the Gateway repairs legacy Codex records whose stored failure reason identifies one of
these turn-local refusals; genuine authentication, refresh, and transport failures remain intact.

## Amendments

**Issue 047 narrows the boundary to inference-only adapters and places each initial adapter against it.**
A Model connection adapter supplies inference and nothing else; Veduta's Agent loop keeps tools, trust decisions, Event log writes and Surface changes for every connection method.

- **ChatGPT** is a Gateway-managed adapter that spawns the exactly-pinned `codex app-server` 0.160.0 child process over stdio JSON-RPC, uses managed device-code login, `model/list` for the catalog and `account/logout` for disconnect, and runs one `thread/start`+`turn/start` per model call — no thread reuse and no resume. It opts into the pinned experimental API and carries only the turn's allowed Veduta `ToolDef`s through `dynamicTools`; every Codex-native tool remains disabled, no provider approval is ever granted, and capability, version, correlation, or schema drift fails the turn closed. Codex owns its credential store inside a per-connection `CODEX_HOME` under the data directory; encryption at rest for that directory is a deployment concern, not a vault integration, and OS-level sandboxing of the child is out of scope for issue 047.
- **Claude subscription** ships as a registry adapter that is unavailable with the exact reason: Anthropic prohibits a third-party product from offering Claude.ai login or routing subscription credentials without prior approval; no `setup-token` workaround is normalized into product UX. Anthropic API keys stay fully supported.
- **BYOK** becomes one Model connection method behind the same contract, and the connection id travels beside the canonical provider on the routed `ModelRef` — pi-ai's `PiModel.provider` is never rewritten.
- The visible routing control is one connection select plus one model select; the internal triage tier follows the same selection rather than exposing a second picker.
- Failover is permitted only to a `connected` connection the user explicitly enabled for fallback, is surfaced in chat and recorded in the usage log; the mock provider is automatic on Loopback, available on Local VPS only through an explicit development control, and never on a VPS — including any mock candidate a hand-edited `routing.json` may contain.

[ADR-0016](0016-primary-agent-connections-author-surfaces.md) defines the eligibility rule: a Model connection must satisfy the complete AgentRunner tool contract before it can power the primary Agent.

The 2026-10-04 upgrade to Codex 0.160.0 preserves the exact-version boundary and existing
protocol schemas after a real authenticated catalog and dynamic-tool round trip. The older
0.146.1 client received a version-filtered catalog without the current 6.x models; refreshing
that catalog could not expose them. See [the compatibility check](../references/codex-0.160-compatibility.md).

Status: accepted

## 2026-10-12 amendment: provider history and local removal

Each Veduta inference thread explicitly sets `ephemeral: true`. Veduta remains the
owner of canonical conversation and tool history; Codex threads are never resumed.
The [pinned local-state review](../references/codex-0.160-local-state.md) defines
recognized legacy cleanup before child acquisition and in backup staging. It preserves
active authorization and non-history runtime state, refuses unknown SQLite layouts,
and never traverses another connection or an external configured path.

Removal permanently retires the connection's pooled acquisition, settles pending
creation and observes child exit before erasing the complete owned `CODEX_HOME`.
Remote logout is best effort using an existing idle child. A termination or filesystem
failure retains revoked, retryable registry state; successful local erasure precedes
final record removal. Backup encryption and Veduta's canonical history do not change.

## 2026-10-19 amendment: official Claude Code subscription inference (#285)

The current Anthropic policy explicitly allows an end user to authenticate the unmodified Claude
Code binary, including when hosted in a third-party platform. This supersedes the issue-047
Claude unavailability decision above; it does not authorize a Veduta OAuth client or collection,
extraction, or direct API use of subscription bearer tokens. The
[dated source review](../references/44-claude-subscription-inference.md) records the changed policy
and the T3 Code, OpenClaw and Hermes implementations.

Claude subscriptions now use the unmodified `@anthropic-ai/claude-code` 2.1.303 native binary,
shipped as an exact dependency. The CLI owns login, credential storage, automatic refresh and
logout under one private `CLAUDE_CONFIG_DIR` per connection. Its browser URL and optional pasted
code travel only through the authenticated Model connection flow. Codes go directly to the
existing CLI process over stdin, are bound to the current attempt and are never persisted or
placed in arguments, model context or diagnostics. Pending attempts fail visibly after restart.
Personal terminal credentials are neither imported nor changed.

The same inference-only boundary and ADR-0016 eligibility apply. Each isolated `claude -p` call
receives canonical Veduta history and allowed tool definitions through stdin. Native tools,
customizations, hooks, MCP and transcript persistence are disabled. A validated structured result
contains text and at most one allowed Veduta tool request. AgentRunner still validates arguments,
executes handlers, applies trust, commits Surfaces and Events, and supplies tool results on the
next model call. Native formatting/validation may take bounded internal steps; it receives no
external-effect tool. This transport currently releases text after final structured validation,
so it does not promise token-by-token text arrival.

Repeated tool-schema fragments are losslessly factored into local JSON Schema definitions before
serialization; the original ToolDef remains the argument-validation authority. The inference
instructions distinguish these application actions from native tools and request only the CLI's
`StructuredOutput` formatting tool. Any other native tool call, including one named after an allowed
Veduta action, still refuses the turn without replay or fallback.

The raw pinned SDK `initialize` control response supplies the CLI's supported model snapshot;
this is not an exhaustive entitlement guarantee. Actual selection still requires an inference
probe. Auth status must identify a Claude subscription, rather than an ambient API or Console
credential. Usage/rate limits retain authorization and never silently select a metered connection.

Removal retires further child acquisition, stops owned processes, attempts official logout and
erases only the owned local configuration. A local cleanup failure retains a revoked record for
retry. Remote revocation is best effort; users can review active sessions in their Claude account.
The CLI's native credential-store permissions and deployment disk encryption remain operator
concerns, as with Codex. No OS-level subprocess sandbox is claimed.
