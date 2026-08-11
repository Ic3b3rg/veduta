# Every primary Agent connection supports Surface authoring

A Model connection is eligible to power Veduta's primary Agent only when it can round-trip every validated `ToolDef` allowed by the turn's Space and trust gates, including Surface, memory, Template, scheduler, Worker, and trust-wrapped external-action tools. It therefore provides **Surface authoring** ([`CONTEXT.md`](../../CONTEXT.md)) as part of the same complete Agent capability set. A connection that yields text only may serve an explicitly tool-less internal role, but it is never offered as a degraded primary chat mode: the founding product contract is that chat modifies persistent Surfaces, independent of provider, model, or whether inference is authorized through BYOK or a provider subscription.

This supersedes only ADR-0014's issue-047 exception that made ChatGPT subscription Agent-routable with `vedutaTools: false`. Provider-native tools remain disabled; the Agent loop still owns tool validation and execution, trust enforcement, Event log writes, and Surface changes. A subscription adapter only translates Veduta tool definitions, tool calls, and tool results between its provider protocol and the AgentRunner contract; it never executes handlers or owns another agent loop. Transport differences cannot change the Agent's product capabilities.

The exactly pinned Codex app-server adapter opts into its experimental `experimentalApi` capability and uses `dynamicTools` to preserve this contract for ChatGPT subscriptions. Accepting pinned protocol churn is preferable to shipping a provider-dependent capability cliff; schema or capability drift fails the connection closed and never falls back to a text-only Agent.

Tool support is an eligibility invariant, not an optional Model connection capability. The `vedutaTools` boolean is removed from the connection contract and PWA: an adapter that cannot satisfy the complete AgentRunner tool contract is unavailable for primary routing rather than represented as a connected-but-degraded method. Explicitly tool-less internal calls are selected by call purpose, never by provider brand or authorization method.

[Issue 070](../../issues/070-codex-tool-parity.md) restores the Codex subscription boundary first; [issue 052](../../issues/052-global-chat-multi-space.md) then removes the separate no-tools restriction from global chat while preserving selective Space context.

Status: accepted
