# Subscription-backed models stay behind the AgentRunner boundary

Veduta may use Claude Code and Codex subscriptions through provider credentials or wrapped inference adapters, but the single Agent loop continues to own tool execution, trust enforcement, Event log writes, and Surface changes. We do not delegate Agent turns to the Claude Code or Codex applications: accepting the extra adapter work keeps behavior and security independent of the selected Model connection instead of allowing provider-side behavior to bypass Veduta's architectural boundaries.

The official Claude subscription path is a Gateway-managed Claude Code/Agent SDK inference adapter with its tools disabled; the official Codex subscription path uses refreshable ChatGPT OAuth credentials. Both sit behind the same Model connection interface and expose the same connection lifecycle to the PWA. Provider-specific authentication and refresh mechanics do not become different onboarding journeys.

The Gateway owns a provider-extensible Model connection registry. The PWA renders connection choices and the shared authorize, verify, connected, expired, and recovery states from registry metadata and protocol events rather than hardcoding Claude- or ChatGPT-specific flows. Claude and ChatGPT are the initial adapters; adding providers such as Gemini, Grok, or OpenRouter must not require a new onboarding architecture.

Model connections are Gateway-wide and shared by every Space. Per-Space credentials or routing overrides are outside this initial design.

Each Model connection is an independently identified instance rather than a singleton keyed by provider. Multiple accounts for the same provider may coexist, while onboarding still requires only one working connection; account pools and ordering stay in the post-onboarding connection settings.

The Agent may inspect and change routing among already-authorized Model connections at the user's request. Adding, reauthorizing, revoking, or removing credentials always crosses into the authenticated PWA connection flow; secrets and authorization codes never enter chat or the LLM context.

The Gateway refreshes credentials automatically and may fail over only to another connection the user has already authorized and enabled for fallback. It never crosses implicitly from a subscription to metered BYOK and never hides an unavailable real connection by answering through the mock provider. When no permitted connection can serve a turn, the turn stops with a visible reconnection action; every provider change is surfaced and recorded.

## Amendments

**Issue 047 narrows the boundary to inference-only adapters and places each initial adapter against it.**
A Model connection adapter supplies inference and nothing else; Veduta's Agent loop keeps tools, trust decisions, Event log writes and Surface changes for every connection method.

- **ChatGPT** is a Gateway-managed adapter that spawns the exactly-pinned `codex app-server` 0.146.1 child process over stdio JSON-RPC, uses the managed device-code login, `model/list` for the catalog and `account/logout` for disconnect, and runs one `thread/start`+`turn/start` per turn — no thread reuse, no resume — with every Codex tool disabled, no approval ever granted, and a fail-closed refusal when the app-server does not confirm an empty tool set. Because that turn cannot carry Veduta's own tools, a ChatGPT connection declares `vedutaTools: false` and answers in text only; this is surfaced to the user rather than hidden, and Veduta's own `ToolDef`s are filtered out before the turn starts. Codex owns its credential store inside a per-connection `CODEX_HOME` under the data directory; encryption at rest for that directory is a deployment concern, not a vault integration, and OS-level sandboxing of the child is out of scope for issue 047.
- **Claude subscription** ships as a registry adapter that is unavailable with the exact reason: Anthropic prohibits a third-party product from offering Claude.ai login or routing subscription credentials without prior approval; no `setup-token` workaround is normalized into product UX. Anthropic API keys stay fully supported.
- **BYOK** becomes one Model connection method behind the same contract, and the connection id travels beside the canonical provider on the routed `ModelRef` — pi-ai's `PiModel.provider` is never rewritten.
- The visible routing control is one connection select plus one model select; the internal triage tier follows the same selection rather than exposing a second picker.
- Failover is permitted only to a `connected` connection the user explicitly enabled for fallback, is surfaced in chat and recorded in the usage log; the mock provider is automatic on Loopback, available on Local VPS only through an explicit development control, and never on a VPS — including any mock candidate a hand-edited `routing.json` may contain.

Status: accepted
