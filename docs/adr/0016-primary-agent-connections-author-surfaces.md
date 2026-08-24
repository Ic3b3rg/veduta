# Every primary Agent connection supports Surface authoring

A Model connection is eligible to power Veduta's primary Agent only when it can round-trip every validated `ToolDef` allowed by the turn's Space and trust gates, including Surface, memory, Template, scheduler, Worker, and trust-wrapped external-action tools. It therefore provides **Surface authoring** ([`CONTEXT.md`](../../CONTEXT.md)) as part of the same complete Agent capability set. An inference route without that contract may serve an explicitly tool-free internal call purpose, but it is never offered for primary chat: the founding product contract is that chat modifies persistent Surfaces, independent of provider, model, or whether inference is authorized through BYOK or a provider subscription.

Provider-native tools remain disabled; the Agent loop owns tool validation and execution, trust enforcement, Event log writes, and Surface changes. A subscription adapter only translates Veduta tool definitions, tool calls, and tool results between its provider protocol and the AgentRunner contract; it never executes handlers or owns another agent loop. Transport differences cannot change the Agent's product capabilities.

The exactly pinned Codex app-server adapter opts into its experimental `experimentalApi` capability and uses `dynamicTools` to preserve this contract for ChatGPT subscriptions. Accepting bounded churn at this pinned experimental boundary is preferable to letting provider choice change the Agent's product capabilities; schema or capability drift therefore fails the turn closed and never changes the selected connection's lifecycle or silently selects another credential after an accepted effect.

Tool support is an eligibility invariant, not an optional Model connection capability. Each adapter declares one `primaryInference` route: builtin and subscription transports both carry the complete AgentRunner contract, while `unavailable` adapters cannot enter primary routing. Explicitly tool-free internal calls are selected by call purpose, never by provider brand or authorization method.

Primary-route eligibility is evaluated independently from credential lifecycle. A stale stored selection or fallback whose adapter declares `unavailable` remains auditable with its original lifecycle state, but contributes no routing candidate; authorization, refresh, verification, and selection reject it with the adapter's exact reason. The PWA likewise requires both a connected record and an available method before offering a primary-routing selector.

[Issue 070](../../issues/070-codex-tool-parity.md) delivers the Codex subscription boundary; [issue 052](../../issues/052-global-chat-multi-space.md) separately owns selective multi-Space work from global chat.

Status: accepted
