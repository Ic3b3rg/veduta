# Research 12 — How OpenClaw uses Claude and ChatGPT subscriptions

> Conducted on 2026-08-05 against the official OpenClaw repository at commit
> [`6aee279`](https://github.com/openclaw/openclaw/commit/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1),
> the exact OpenAI Codex version it bundles (`0.146.0`, source commit
> [`e363b08`](https://github.com/openai/codex/commit/e363b08c9175ac1cbe5893615dd2cb9ddf95043b)),
> and current first-party provider documentation. The question is whether OpenClaw really lets
> a user spend a Claude or ChatGPT consumer subscription without supplying an API key, and
> whether Veduta may rely on the same contract.

## Decision

The user's factual claim is **technically true for both providers**, but “it works” and “the
provider supports a third-party product doing it” have different answers.

| Provider path                      | No user-supplied API key?                                                 | What owns the model turn?                                                                                                        | Does OpenClaw retain consumer credentials?                                                                                                   | Publicly supported for Veduta?                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ChatGPT, OpenClaw fresh setup      | Yes; OpenClaw performs Codex OAuth and receives access and refresh tokens | Normally the bundled first-party Codex app-server; an explicit override can make OpenClaw call the ChatGPT Codex endpoint itself | Yes, in OpenClaw's per-agent SQLite auth store; it passes the access token into Codex through an external-auth login RPC                     | **Not in the form OpenClaw implements.** The exact RPC variant it uses is marked OpenAI-internal and unstable. A different path is public: let Codex app-server own its documented `chatgpt` or `chatgptDeviceCode` login and the turns |
| Claude, existing Claude Code login | Yes; the user first signs in to Claude Code                               | The installed first-party `claude -p` process                                                                                    | Yes during setup as an identity/profile snapshot; for the normal native-login run, OpenClaw verifies the live identity and forwards no token | **No, absent specific Anthropic approval.** Anthropic currently forbids third-party products from offering Claude.ai login or routing Free/Pro/Max credentials                                                                          |

Therefore Veduta should **not copy either private credential bridge**. The evidence supports one
narrow candidate for a no-API-key feature: a Codex runtime adapter in which the published
first-party Codex app-server owns browser/device login, refresh tokens, account state, and every
turn. Claude subscription support should remain out of scope unless Anthropic gives Veduta
written approval or publishes a new third-party authentication contract.

## ChatGPT subscription: end-to-end trace

### 1. Setup and OAuth ownership

OpenClaw exposes “Codex subscription” in onboarding and through
`openclaw models auth login --provider openai`; the documented fresh route selects
`openai/gpt-5.6-sol` and may automatically choose the Codex app-server runtime
([OpenClaw provider guide, lines 295–359](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/providers/openai.md#L295-L359)).
This is not an API-key convenience wrapper. OpenClaw itself creates a PKCE authorization flow
against `auth.openai.com`, using the Codex client id, a loopback callback, offline access, and
`originator=openclaw`
([authorization construction, lines 4–54](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/openai/openai-chatgpt-oauth-authorization.runtime.ts#L4-L54)).
It exchanges the browser callback code and returns access token, refresh token, expiry, and
account id
([OAuth flow, lines 169–295](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/openai/openai-chatgpt-oauth-flow.runtime.ts#L169-L295)).

OpenClaw deliberately does not adopt `~/.codex` during normal onboarding. Its guide says the new
OAuth material belongs to OpenClaw's own auth store
([lines 406–410](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/providers/openai.md#L406-L410)).
The provider converts the result into an OAuth profile containing the access and refresh tokens
([provider, lines 475–505](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/openai/openai-chatgpt-provider.ts#L475-L505));
the shared auth-result builder makes those fields persistent
([lines 126–180](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/plugin-sdk/provider-auth-result.ts#L126-L180)).
The CLI upserts each profile
([lines 417–451](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/commands/models/auth.ts#L417-L451))
into `openclaw-agent.sqlite`
([SQLite path, lines 35–69](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/agents/auth-profiles/sqlite.ts#L35-L69)).

So the identity is a real consumer ChatGPT/Codex identity, no API key is requested, and
OpenClaw becomes a token owner. A narrow migration/bootstrap path can import an existing Codex
login, but it is not the fresh onboarding path and does not change this conclusion.

### 2. Delegated inference path

For the normal fresh subscription route, OpenClaw bundles the official `@openai/codex` package
at exactly `0.146.0`
([plugin package, lines 1–15](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/package.json#L1-L15)).
It resolves the package's native `codex` executable
([managed binary, lines 40–69 and 94–108](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/managed-binary.ts#L40-L108)),
launches it as `codex app-server --listen stdio://`
([runtime options, lines 275–288](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/config-runtime.ts#L275-L288)),
and communicates over JSON-RPC. OpenClaw asks Codex to create the thread with `thread/start`
([lines 443–475](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/thread-lifecycle-io.ts#L443-L475))
and starts inference with `turn/start`
([lines 118–142](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/run-attempt-turn-request.ts#L118-L142)).
The first-party Codex process therefore owns the actual turn.

The auth handoff is more important than the process boundary. OpenClaw converts its stored
profile into `chatgptAuthTokens`, including the bearer access token and ChatGPT account id
([credential resolution, lines 829–880](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/auth-bridge.ts#L829-L880),
[RPC payload, lines 1116–1126](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/auth-bridge.ts#L1116-L1126)),
then sends it to `account/login/start`
([lines 548–620](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/auth-bridge.ts#L548-L620)).
OpenClaw, not Codex, refreshes that OAuth family and answers Codex's refresh requests
([client handler, lines 22–51](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/codex/src/app-server/client-runtime.ts#L22-L51)).

There is also an explicit `agentRuntime.id: "openclaw"` route. On that route OpenClaw uses its
own embedded runtime and the consumer bearer against
`https://chatgpt.com/backend-api/codex`, rather than delegating the turn
([route table, lines 340–350](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/providers/openai.md#L340-L350),
[endpoint constant, lines 4–20](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/openai/base-url.ts#L4-L20)).
This proves that “OpenClaw supports a ChatGPT subscription” is true, but not that every one of
its routes has the same support status.

### 3. OpenAI's public boundary

OpenAI does publish a usable, first-party integration boundary. The matching Codex source calls
`codex app-server` the interface for rich clients and documents its JSON-RPC transports
([Codex `0.146.0` app-server README, lines 1–28](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/app-server/README.md#L1-L28)).
Its auth contract recommends **ChatGPT-managed** login: a client sends `type: "chatgpt"` or
`type: "chatgptDeviceCode"`, while Codex owns OAuth, persistence, and refresh
([lines 2072–2093](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/app-server/README.md#L2072-L2093),
[browser example, lines 2145–2162](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/app-server/README.md#L2145-L2162),
[device-code example, lines 2188–2200](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/app-server/README.md#L2188-L2200)).
OpenAI also explicitly documents that Codex can use a ChatGPT plan without an API key
([Codex README, lines 68–72](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/README.md#L68-L72)).

OpenClaw does **not** use that public auth ownership model for a fresh OpenClaw login. In the
same upstream source version, `chatgptAuthTokens` is annotated as unstable and
“FOR OPENAI INTERNAL USE ONLY - DO NOT USE”
([protocol, lines 65–104](https://github.com/openai/codex/blob/e363b08c9175ac1cbe5893615dd2cb9ddf95043b/codex-rs/app-server-protocol/src/protocol/v2/account.rs#L65-L104)).
OpenClaw's claim that OpenAI “explicitly supports” its subscription OAuth usage
([provider guide, lines 26–27](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/providers/openai.md#L26-L27))
is therefore too broad for the implementation inspected. The delegated Codex runtime is public;
OpenClaw's external-token injection and direct ChatGPT endpoint transport are not established as
public third-party contracts.

## Claude subscription: end-to-end trace

### 1. Setup imports the existing Claude Code identity

OpenClaw's supported setup asks the user to install and sign in to Claude Code, then select
“Claude CLI” during onboarding
([OpenClaw Anthropic guide, lines 89–124](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/providers/anthropic.md#L89-L124)).
The setup implementation reads the live Claude CLI credential and fails if the host is not
authenticated
([provider registration, lines 938–948](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/anthropic/register.runtime.ts#L938-L948)).

This is private credential reuse, not merely checking that a command exists. OpenClaw reads
Claude Code's macOS Keychain entry or `~/.claude/.credentials.json`
([credential locations, lines 20–27](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/agents/cli-credentials.ts#L20-L27),
[read precedence, lines 526–559](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/agents/cli-credentials.ts#L526-L559)),
parses the access token, refresh token, expiry, and plan metadata
([lines 127–172](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/agents/cli-credentials.ts#L127-L172)),
and copies them into a `claude-cli` auth profile
([migration, lines 183–216](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/anthropic/cli-migration.ts#L183-L216)).
The copied profile is used as an identity and routing snapshot in OpenClaw's store.

OpenClaw also accepts a `claude setup-token`. That remains a bearer credential even though it
is not an API key, so it does not remove credential-handling risk; it merely changes the
credential form.

### 2. The first-party Claude CLI owns inference

For an imported native login, OpenClaw does not pass its stored token copy into the child.
Immediately before execution it re-reads the live Claude login, verifies that its identity
matches the selected profile, clears `authCredential`, and lets Claude refresh its own
single-use token family
([CLI preparation, lines 570–607](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/src/agents/cli-runner/prepare.ts#L570-L607)).

The bundled adapter then launches the official `@anthropic-ai/claude-code` executable as
`claude -p --output-format stream-json ...`, feeding prompts over stdin and consuming JSONL
output
([CLI adapter, lines 116–205](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/anthropic/cli-backend.ts#L116-L205)).
The first-party CLI owns the agent loop and model request. If the selected profile is instead an
OpenClaw-managed OAuth/setup token, OpenClaw can send that secret to Claude through file
descriptor 3
([lines 42–113](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/extensions/anthropic/cli-backend.ts#L42-L113)).

OpenClaw's own guide records the observed billing result: after Anthropic's 2026-06-15 pause,
Claude Agent SDK, `claude -p`, and third-party app calls still consume the signed-in
subscription's limits
([lines 24–36](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/providers/anthropic.md#L24-L36)).
Anthropic's current help article confirms that temporary behavior
([2026-06-16 update](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
Thus the no-API-key claim is operationally true.

### 3. Anthropic's policy boundary overrides the technical result

Anthropic's current first-party legal guidance says consumer OAuth is for ordinary use of
Claude Code and other native Anthropic applications. It directs product developers to API-key
authentication and says third parties may not offer Claude.ai login or route Free/Pro/Max
credentials for users
([Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)).
The Agent SDK overview repeats that restriction unless a developer has prior approval
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started)).

The temporary statement that `claude -p` usage currently draws from plan limits describes
billing behavior; it does not grant every third-party product permission to authenticate that
way. OpenClaw says Anthropic staff privately told it that its usage is allowed
([OpenClaw OAuth guide, lines 90–103](https://github.com/openclaw/openclaw/blob/6aee2792d9c4cd3c9c0edf34a61b95abebc164a1/docs/concepts/oauth.md#L90-L103)),
but no provider-owned public evidence of an OpenClaw approval was found. Veduta cannot inherit a
private assurance made to another product.

## Implications for Veduta

1. **ChatGPT can be offered without a user-supplied API key only behind the first-party Codex
   boundary.** A future adapter should launch a pinned, verified Codex distribution, use the
   documented `chatgpt` or `chatgptDeviceCode` RPC, and let Codex own token persistence and
   refresh. Veduta should store only a non-secret account/runtime binding and Codex session ids.
2. **Do not reproduce OpenClaw's OpenAI OAuth client or `chatgptAuthTokens` handoff.** That creates
   a second token owner around an upstream RPC explicitly marked internal-only. Do not call
   `chatgpt.com/backend-api/codex` directly either; keep actual inference inside Codex.
3. **Do not advertise Claude subscription login.** The subprocess technique is real and
   technically simple, but Anthropic's public contract rejects the product use case without
   prior approval. Installing Claude Code on the same VPS would not change that policy boundary.
4. **BYOK remains the portable provider path.** Subscription runtimes are provider-specific
   delegated integrations, not replacements for the existing `ModelRef`/`AgentRunner` boundary.
   If Codex support is pursued, its adapter must stay behind Veduta's own `AgentRunner`; no
   OpenAI package should leak into the Gateway or workers.
5. **Re-verify at implementation time.** Both providers changed subscription behavior during
   this research window. Pin the runtime and protocol version, display the owning provider and
   billing surface during setup, and disable the route if the public contract disappears.

## Answer to the original question

OpenClaw really does let users run Claude and ChatGPT-backed turns without manually providing an
API key. For ChatGPT it obtains and stores its own Codex OAuth tokens, then usually delegates the
turn to the official Codex app-server. For Claude it adopts an existing Claude Code login and
delegates the turn to `claude -p`. These implementations prove technical feasibility, not equal
permission: OpenClaw's OpenAI token injection uses an internal-only interface, and Anthropic
publicly disallows consumer credential routing by unapproved third parties. The safe reusable
idea is therefore **delegation to a provider-owned runtime that also owns authentication**, and
today only Codex publishes that complete boundary.
