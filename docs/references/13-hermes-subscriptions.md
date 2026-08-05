# Research 13 — How Hermes uses Claude and ChatGPT subscriptions

> Conducted on 2026-08-05 from provider-owned documentation and pinned source
> repositories. Answers [issue #61](https://github.com/Ic3b3rg/veduta/issues/61).

## Verdict

**The user's claim is true in the operational sense:** Hermes can run inference billed to a
ChatGPT or Claude consumer account without asking the user for a provider API key. It is not
true that both integrations use the same kind of supported third-party API.

Hermes has four relevant paths:

| Hermes path                                     | Manual provider API key?                          | Credential source                                                             | Who owns the model turn?                                  | Provider-documented integration boundary?                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Codex, default `codex_responses`         | No                                                | ChatGPT OAuth minted by Hermes or imported from Codex CLI                     | Hermes                                                    | **No.** Hermes sends the token to an internal ChatGPT Codex endpoint while presenting Codex CLI identity.                                      |
| OpenAI Codex, optional `codex_app_server`       | No                                                | ChatGPT OAuth managed by Codex CLI                                            | Official Codex app-server                                 | **Yes.** OpenAI publishes the app-server protocol for applications built on Codex.                                                             |
| Anthropic, main `anthropic` provider with OAuth | No                                                | Claude Code setup token, Claude Code credential store, or Hermes-minted OAuth | Hermes                                                    | **No public contract found for this direct route.** Hermes sends the borrowed token to the Messages API while presenting Claude Code identity. |
| Bundled Claude Code skill                       | No, when Claude Code is signed into a Claude plan | Claude Code manages its own login                                             | Official Claude Code process, for the delegated task only | **Yes.** Anthropic currently documents subscription use for the Agent SDK and `claude -p`; this is not Hermes's main model provider.           |

“No API key” therefore means “an OAuth bearer token is used instead.” The bearer and refresh
tokens are still sensitive credentials. The important distinction is whether Hermes handles
those credentials and calls the model itself, or delegates the complete turn to a provider-owned
runtime.

## Inspected snapshots

- Hermes Agent: [`NousResearch/hermes-agent` at
  `0531aad55dbec9feca98ec48e14ce562d4e1e86b`](https://github.com/NousResearch/hermes-agent/tree/0531aad55dbec9feca98ec48e14ce562d4e1e86b),
  committed 2026-08-05.
- OpenAI Codex: [`openai/codex` at
  `9d00bb01c0a712fb7c2f5b002bdf33bcc0fc352c`](https://github.com/openai/codex/tree/9d00bb01c0a712fb7c2f5b002bdf33bcc0fc352c),
  committed 2026-08-05.
- Claude Agent SDK for Python: [`anthropics/claude-agent-sdk-python` at
  `e8238a3ccef529a05e4d933870c6a85fbfa3346a`](https://github.com/anthropics/claude-agent-sdk-python/tree/e8238a3ccef529a05e4d933870c6a85fbfa3346a),
  committed 2026-08-04.

The plan and support conclusions also use provider help and platform pages retrieved on
2026-08-05, because entitlement rules can change independently of repository code.

## ChatGPT path 1: Hermes owns OAuth and the inference call

### Setup and credential acquisition

Hermes advertises `hermes model` → OpenAI Codex as “ChatGPT OAuth” and says that the Codex CLI
is not required. It stores its own credentials in `~/.hermes/auth.json`, although it can import
`~/.codex/auth.json`
([provider documentation](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/website/docs/integrations/providers.md#L83-L86)).

This is a Hermes-owned OAuth implementation, not a call to `codex login`:

1. Hermes embeds the Codex OAuth client ID and selects
   `https://chatgpt.com/backend-api/codex` as its base URL
   ([constants](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L83-L108)).
2. `hermes model` reuses Hermes credentials, offers to import Codex CLI tokens, or starts a new
   device-code login
   ([login selection](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L7688-L7759)).
3. The new-login branch calls OpenAI's device-auth endpoints directly, polls for an authorization
   code, and exchanges it for access and refresh tokens using that embedded client ID
   ([device authorization](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L8015-L8118),
   [token exchange](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L8134-L8211)).
4. Imported Codex credentials are read from `~/.codex/auth.json`
   ([import](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L3896-L3927));
   Hermes then copies them into its own store. New and imported tokens are saved with
   `auth_mode: chatgpt`
   ([save](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L3674-L3699)).

The web administration UI reaches the same outcome. Its modal starts either device-code or PKCE
login and polls/submits through Hermes endpoints
([modal](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/web/src/components/OAuthLoginModal.tsx#L42-L57),
[poll and submit](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/web/src/components/OAuthLoginModal.tsx#L90-L147)).
For OpenAI, the Hermes web service duplicates the device flow inline and persists the returned tokens
([worker](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/web_server.py#L10799-L10932)).

The Hermes auth store uses an atomic mode-`0600` write and tightens its parent directory
([persistence](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth.py#L1241-L1271)).
That protects the local secret but does not change the support status of the integration.

### Actual inference boundary

At runtime, Hermes resolves the OAuth access token into a generically named `api_key` field and
selects `codex_responses`
([resolver](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/runtime_provider.py#L1943-L1954)).
The name is an internal compatibility field: it contains the OAuth bearer token, not a key that
the user created in the OpenAI API console.

Hermes then:

- constructs an OpenAI SDK client with that token and the internal ChatGPT base URL
  ([client arguments](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/agent_init.py#L1150-L1169),
  [SDK construction](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/agent_runtime_helpers.py#L2349-L2358));
- adds `originator: codex_cli_rs`, a Codex-shaped user agent, and a ChatGPT account header. The
  code says the front door allows a small set of first-party originators and explicitly pins the
  Codex CLI identity
  ([headers and rationale](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/auxiliary_client.py#L968-L1004));
- calls `active_client.responses.create(..., stream=True)` from Hermes's own loop
  ([request](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/codex_runtime.py#L1231-L1275)).

So the effective request is Hermes → OpenAI SDK →
`POST https://chatgpt.com/backend-api/codex/responses`. The first-party Codex process does not
own the turn. Hermes itself describes the endpoint's model allow-list as undocumented and
shifting
([source note](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/auxiliary_client.py#L957-L965)).

This path can work and does avoid a manual API key, but no provider-owned source reviewed here
documents raw ChatGPT OAuth reuse against that endpoint as a third-party integration contract.
Its dependency on a first-party client ID, internal URL, allow-list, and asserted client identity
makes it a compatibility workaround, not a stable boundary Veduta should copy.

## ChatGPT path 2: official Codex app-server owns the turn

Hermes also has a materially different, opt-in path. With
`model.openai_runtime: codex_app_server`, Hermes bypasses its own tool loop and hands the turn to
the Codex CLI app-server
([Hermes documentation](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/website/docs/user-guide/features/codex-app-server-runtime.md#L6-L22),
[dispatch](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/conversation_loop.py#L1401-L1413)).
This path requires the official Codex CLI and a separate `codex login`; the child reads
`~/.codex/auth.json`, not Hermes's auth store
([prerequisites](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/website/docs/user-guide/features/codex-app-server-runtime.md#L150-L168)).
Hermes spawns `codex app-server` and speaks newline-delimited JSON-RPC over stdio
([transport](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/transports/codex_app_server.py#L1-L14),
[process boundary](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/transports/codex_app_server.py#L71-L142)).

This is a provider-published integration boundary:

- OpenAI calls app-server the interface used to power rich Codex clients and publishes its
  JSON-RPC transports
  ([app-server overview](https://github.com/openai/codex/blob/9d00bb01c0a712fb7c2f5b002bdf33bcc0fc352c/codex-rs/app-server/README.md#L1-L28)).
- Its documentation explicitly addresses “applications building on top of” app-server and asks
  them to identify themselves
  ([client identity](https://github.com/openai/codex/blob/9d00bb01c0a712fb7c2f5b002bdf33bcc0fc352c/codex-rs/app-server/README.md#L119-L123)).
- ChatGPT-managed auth is the recommended mode: Codex owns OAuth, persistence, and token refresh
  ([auth modes](https://github.com/openai/codex/blob/9d00bb01c0a712fb7c2f5b002bdf33bcc0fc352c/codex-rs/app-server/README.md#L2150-L2171)).
- The documented lifecycle sends input with `turn/start` and receives model output, tool progress,
  side effects, and completion events from Codex
  ([turn lifecycle](https://github.com/openai/codex/blob/9d00bb01c0a712fb7c2f5b002bdf33bcc0fc352c/codex-rs/app-server/README.md#L74-L87)).

OpenAI's current help page says Codex is included across ChatGPT plans and instructs users to
sign into a preferred official Codex client
([Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)).
This makes the optional app-server route both no-manual-key and provider-documented. The tradeoff
is structural: Codex owns the model turn, its tools, sandbox, approvals, and session semantics;
Hermes becomes a shell and exposes additional capabilities back to Codex through MCP.

## Claude path: first-party credentials, Hermes-owned Messages call

### Setup and credential storage

The primary `hermes model` flow offers “Claude Pro/Max subscription (OAuth login)” separately
from an Anthropic API key
([choice](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/model_setup_flows.py#L3002-L3093)).
For OAuth it runs the official `claude setup-token`, then prefers linking to Claude Code's
credential store; if unavailable, it can save a pasted setup token in Hermes's environment file
([flow](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/main.py#L4458-L4517)).

Hermes can read Claude Code credentials from the macOS Keychain service
`Claude Code-credentials` or `~/.claude/.credentials.json`
([Keychain](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L954-L1009),
[file and reconciliation](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L1012-L1077)).
It can also refresh those credentials itself with the Claude Code OAuth client ID and write the
rotated pair back into Claude Code's file
([refresh](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L1095-L1209),
[write-back](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L1212-L1277)).

There is also a Hermes-native route, used by `hermes auth add anthropic` and the web
administration UI. It embeds the Claude Code OAuth client ID and scopes, opens
`claude.ai/oauth/authorize`, exchanges the code itself, and stores the result in Hermes's
credential pool
([client identity and scopes](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L1458-L1485),
[authorization and exchange](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L1501-L1628),
[pool insertion](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/hermes_cli/auth_commands.py#L224-L248)).

### Actual inference boundary

Regardless of which OAuth source wins, Hermes does not hand the main turn to Claude Code. Its
token resolver explicitly accepts Hermes environment tokens, Claude Code tokens, regular API
keys, Claude Code's credential file, and the Hermes OAuth pool
([resolution order](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L1357-L1412)).
It then constructs the Anthropic SDK client itself. For OAuth tokens it uses bearer auth and adds
Claude Code beta headers, a `claude-code/... (external, cli)` user agent, and `x-app: cli`
([client construction](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L826-L912)).

The request is further transformed to present Claude Code identity: Hermes prepends “You are
Claude Code,” replaces Hermes/Nous names in the system prompt, and rewrites tool names to avoid
the provider's third-party-app classifier
([compatibility transforms](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/anthropic_adapter.py#L2846-L2949)).
Finally, Hermes's own loop invokes `request_client.messages.stream(...)`
([Messages call](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/agent/chat_completion_helpers.py#L3543-L3589)).

The effective request is therefore Hermes → Anthropic SDK → Messages API, authenticated with a
consumer OAuth/setup token while imitating the Claude Code client. The public Claude API auth
documentation currently lists API keys and Workload Identity Federation, not consumer-plan
OAuth tokens
([Claude API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)).
No provider-owned source reviewed here documents Hermes's direct bearer-token route as a public
third-party Messages API contract.

Hermes does bundle a separate skill that executes `claude -p` or an interactive Claude Code
process for delegated coding work
([skill](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/website/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-claude-code.md#L32-L64)).
That is a first-party runtime boundary, but only for tasks explicitly delegated to the skill; it
does not replace the main Anthropic provider path described above.

## Current Anthropic support caveat

Hermes's provider page says its OAuth path requires Claude Max plus purchased extra-usage
credits, never consumes the base Max allowance, and does not support Pro
([Hermes claim](https://github.com/NousResearch/hermes-agent/blob/0531aad55dbec9feca98ec48e14ce562d4e1e86b/website/docs/integrations/providers.md#L109-L125)).
That statement should not be generalized to Anthropic's documented integration path.

Anthropic's Help Center posted a June 16, 2026 update saying a planned billing change was paused
and that, for now, Claude Agent SDK, `claude -p`, and third-party app usage still draw from the
user's subscription limits
([Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
The official Python SDK bundles and invokes Claude Code
([bundled CLI](https://github.com/anthropics/claude-agent-sdk-python/blob/e8238a3ccef529a05e4d933870c6a85fbfa3346a/README.md#L11-L18),
[subprocess transport](https://github.com/anthropics/claude-agent-sdk-python/blob/e8238a3ccef529a05e4d933870c6a85fbfa3346a/src/claude_agent_sdk/_internal/transport/subprocess_cli.py#L769-L843))
and explicitly covers products offered to end users under Anthropic's Commercial Terms
([terms note](https://github.com/anthropics/claude-agent-sdk-python/blob/e8238a3ccef529a05e4d933870c6a85fbfa3346a/README.md#L357-L359)).

The provider update validates the Agent SDK/`claude -p` boundary. It does **not** retroactively
document Hermes's raw token replay, identity substitution, or tool-name rewriting. The most
defensible conclusion is therefore:

- Hermes's main Claude OAuth route works by compatibility behavior observed against private
  subscription auth, with unclear durability and support.
- Anthropic's currently documented no-manual-key route for a third-party product is the Claude
  Agent SDK/Claude Code process, where the first-party runtime owns the turn.
- Hermes's Max-plus-extra-only warning appears stale for the documented Agent SDK/`claude -p`
  route, while it may still describe behavior Hermes observed on its distinct direct route.

## Implication for Veduta

The useful precedent is not “consumer OAuth tokens can be treated like API keys.” The useful
precedent is “a provider-owned local agent runtime can expose a supported process boundary that
uses the user's subscription.”

For a no-manual-key Veduta profile:

1. **Evaluate OpenAI Codex app-server as the ChatGPT adapter.** It is public, explicitly intended
   for applications, keeps OAuth inside Codex, and can use ChatGPT plan limits. The design cost is
   that Codex owns the full turn rather than acting as a replaceable model transport.
2. **Evaluate Claude Agent SDK/`claude -p` as the Claude adapter.** Anthropic currently says this
   usage can draw from the user's subscription. It likewise delegates the turn to Claude Code
   and brings provider-specific tools, permissions, session behavior, and terms.
3. **Do not copy Hermes's default direct-token implementations.** Both rely on provider client
   identities and undocumented compatibility behavior. They are brittle technically and are not
   a sound contract for a product expected to keep working unattended.
4. **Keep these adapters separate from BYOK model transports.** Subscription-backed agent
   runtimes and API-key-backed model calls have different ownership, events, tools, approvals,
   persistence, quotas, and failure modes. Pretending they are the same interface would hide the
   central architectural tradeoff.

This research establishes feasibility without an API key, but it does not by itself select an
implementation. The next design question is whether Veduta can preserve its single Agent,
Surface, Event log, trust, and approval invariants when a provider-owned runtime controls each
model turn.
