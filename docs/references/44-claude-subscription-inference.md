# Research 44 — Claude subscription inference through the official CLI

> Researched on 2026-10-19 from Anthropic documentation, published Anthropic packages,
> and pinned upstream source. This is dated evidence for the Claude Model connection,
> not a replacement for [ADR-0014](../adr/0014-subscription-inference-boundary.md) or
> [ADR-0016](../adr/0016-primary-agent-connections-author-surfaces.md).

## Finding

Use the **unmodified official Claude Code executable**, letting it own login,
credential storage and refresh. Give each Model connection its own
`CLAUDE_CONFIG_DIR`. Invoke it as a bounded, tool-free inference process; translate
validated structured responses into Veduta tool-call requests, and return their
results on the next Veduta-owned model call. This retains the meaning of
[Model connection](../../GLOSSARY.md), the wrapped runtime in
[ADR-0004](../adr/0004-typescript-pi-agent-core.md), and full Surface authoring.
This recommendation is an architectural inference from the evidence below.

The old blanket conclusion that Claude subscription support necessarily requires
Anthropic's prior approval is incomplete against today's documentation. Anthropic's
legal page now expressly allows users to authenticate the unmodified Claude Code
binary with their own subscriptions, including on platforms hosting it. It requires
the binary to remain unmodified, its built-in authentication methods to remain
available, and usage to be billed directly to the end user. It separately forbids
third-party applications from collecting or intermediating Claude.ai credentials
or implementing their own Claude.ai login. This supports wrapping the published
binary, rather than extracting its credentials or implementing OAuth with its
public client identifier. [Anthropic legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)

The help article updated **October 7, 2026** states that Claude Agent SDK,
`claude -p`, and third-party app use can still draw from subscription limits; Max
and Team also include monthly API credits. This is current billing evidence, not
a promise of unlimited use. [Claude plan and Agent SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

The Agent SDK quickstart still contains its prior-approval warning for third-party
Claude.ai login. Do not interpret the help article as permission to build a new
direct-token inference service. The explicit unmodified-binary exception above is
the narrower integration boundary. [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart#setup)

## Authentication choices

Anthropic documents browser login with a pasted-code fallback when a local browser
callback cannot reach the CLI, including SSH and containers. Separate
`CLAUDE_CONFIG_DIR` values isolate accounts, including their macOS Keychain entries
and Linux credential files. The official CLI owns those stores and refreshes;
Veduta should neither inspect nor reproduce them.
[Authentication](https://code.claude.com/docs/en/authentication#log-in-to-claude-code)

| Mechanism                 | Evidence and suitability                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing CLI login        | Lowest friction when it belongs to the same Gateway identity and intended connection directory. Query non-secret CLI status, never copy tokens.                                                              |
| CLI-managed browser login | Start `claude auth login --claudeai`; surface its own authorization URL. Browser approval remains on Anthropic's site.                                                                                       |
| Manual callback code      | Forward the user's one-time code directly to that same CLI process's stdin. Do not store or log it. This supports a browser on another machine.                                                              |
| `claude setup-token`      | Official one-year model-request token for CI/scripts. It is printed without being saved and supplied to the CLI through `CLAUDE_CODE_OAUTH_TOKEN`. It adds secret handling and is a less convenient default. |
| Device authorization      | No public Claude subscription device-code contract or corresponding CLI flag was found. Do not copy the Codex device flow or label PKCE as device authorization.                                             |
| Application-owned PKCE    | Implemented in some competitors, but not an official public third-party OAuth contract. Unnecessary for the recommended binary-owned path.                                                                   |

The setup token is limited to model requests and does not establish Remote Control
or Claude.ai connectors. `--bare` ignores both saved subscription OAuth and
`CLAUDE_CODE_OAUTH_TOKEN`; it requires API-key/provider authentication, so it is
unsuitable here. [Token generation](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token),
[bare-mode authentication](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode)

The CLI exposes `auth status` as JSON with an exit status and `authMethod`, plus
`auth login` and `auth logout`. Login accepts `--claudeai`, `--console`, `--email`
and `--sso` in the inspected build; `--no-browser` and `--code` are not login flags.
The documented `--no-browser` belongs to **MCP login**, a different flow.
[CLI reference](https://code.claude.com/docs/en/cli-reference#cli-commands)

## Pin and direct protocol observations

The public npm registry reported **`@anthropic-ai/claude-code` 2.1.303** during
this research. Its platform-specific optional packages provide the official native
executable. An exact package dependency avoids relying on an arbitrary globally
installed CLI and needs no Agent SDK dependency.
[Published CLI metadata](https://registry.npmjs.org/@anthropic-ai/claude-code/2.1.303)

The published Agent SDK 0.3.303 was inspected as a protocol reference, not adopted
as Veduta's runtime. Its `core.mjs` implements `supportedModels()` by returning
the `models` from initialization; `sdk.d.ts` defines the initialization response.
[Published SDK metadata](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/0.3.303)

The corresponding raw request and response are:

```json
{ "type": "control_request", "request_id": "catalog-id", "request": { "subtype": "initialize" } }
```

```json
{
  "type": "control_response",
  "response": { "subtype": "success", "request_id": "catalog-id", "response": { "models": [] } }
}
```

A native 2.1.303 probe confirmed this without sending a user message. Model rows
contained `value`, `resolvedModel`, `displayName`, `description`, and capability
fields such as `supportedEffortLevels`. Deduplicate resolved IDs instead of
offering both `default` and `opus` when they resolve to the same model. A logged-out
fresh configuration still returned a generic menu: initialization is **not**
proof of subscription readiness. The account must pass CLI status and inference
verification separately.

A second isolated probe started `auth login --claudeai` with stdin/stdout pipes
and `BROWSER=/usr/bin/true`. It printed an official authorization link and
`Paste code here if prompted >` without requiring a TTY. The link used
`https://claude.com/cai/oauth/authorize`, `response_type=code`, PKCE `S256`, and
`https://platform.claude.com/oauth/code/callback`. Therefore a browser link followed
by an optional code field can drive the **existing CLI flow** without implementing
the token exchange. The `BROWSER` behavior is a pinned-runtime observation, not a
documented permanent API.

Both probes used newly created configuration directories and no existing login.
They terminated without completing authorization, created no credential file,
and removed their temporary data. No local credentials were read, copied, printed
or retained. Neither probe verifies a real account or subscription inference.

## What the reference projects actually do

The following snapshots were retrieved on 2026-10-19; upstream `main` is moving.

| Project                       | Inspected revision                                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3 Code                       | [`5307c233`](https://github.com/pingdotgg/t3code/tree/5307c233b1f0ae72b8894dd39d94019aaf9e7cb8), committed 2026-10-19                                                                          |
| OpenClaw                      | [`ae6b8574`](https://github.com/openclaw/openclaw/tree/ae6b85748b3e43b051896e3ad5cf17803e4925ca), committed 2026-10-19                                                                         |
| Hermes Agent                  | [`602d76a7`](https://github.com/NousResearch/hermes-agent/tree/602d76a72d1597b68f6def0c61ca6ac7802a92fb), committed 2026-10-19                                                                 |
| Hermes official Claude plugin | [`6dacaadd`](https://github.com/NousResearch/hermes-official-plugins/tree/6dacaaddbfd8e98dfc524096c44f712f743246b8/claude-subscription-directsdk), pinned by Hermes's catalog as version 0.3.3 |

### T3 Code

T3's user guide delegates login and configuration to Claude Code and recommends a
separate `CLAUDE_CONFIG_DIR` per account. Its full coding harness uses the Agent
SDK and native tool/session behavior; that entire harness would not fit Veduta's
inference-only boundary. [Claude provider guide](https://github.com/pingdotgg/t3code/blob/5307c233b1f0ae72b8894dd39d94019aaf9e7cb8/docs/user/providers-claude.md),
[Claude harness](https://github.com/pingdotgg/t3code/blob/5307c233b1f0ae72b8894dd39d94019aaf9e7cb8/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts)

Its smaller text-generation adapter is a close implementation precedent: it calls
the CLI with `-p`, JSON output, `--json-schema`, `--tools ""`, disabled hooks and
slash commands, strict MCP configuration, and `dontAsk`. It feeds the prompt on
stdin, validates `structured_output`, and checks stdout error envelopes because
stderr can contain only wrapper notices. It omits strict MCP when managed MCP
configuration makes that flag invalid. Veduta should retain an explicit fail-closed
boundary for such incompatible managed configuration, rather than silently inherit
native tools. [Text-generation source](https://github.com/pingdotgg/t3code/blob/5307c233b1f0ae72b8894dd39d94019aaf9e7cb8/apps/server/src/textGeneration/ClaudeTextGeneration.ts)

### OpenClaw

OpenClaw currently prefers its installed Claude CLI route for subscriptions. Its
documentation explicitly says native login tokens are not read, stored, refreshed
or forwarded by OpenClaw. The CLI owns them, and account checks use `auth status`.
Its full CLI runtime has warm native sessions, native tools and native approvals;
copying that runtime would change Veduta's Agent ownership.
[Anthropic provider](https://github.com/openclaw/openclaw/blob/ae6b85748b3e43b051896e3ad5cf17803e4925ca/docs/providers/anthropic.md)

OpenClaw also retains setup-token/direct-API and application-owned PKCE code, with
refresh and manual callback handling. Their presence does not establish a public
OAuth contract for Veduta; prefer the documented CLI path.
[OAuth guide](https://github.com/openclaw/openclaw/blob/ae6b85748b3e43b051896e3ad5cf17803e4925ca/docs/concepts/oauth.md),
[PKCE implementation](https://github.com/openclaw/openclaw/blob/ae6b85748b3e43b051896e3ad5cf17803e4925ca/src/llm/utils/oauth/anthropic.ts)

### Hermes

Hermes core retains direct Anthropic token discovery, borrowed Claude credential
stores, refresh, and a PKCE flow. Its direct Messages adapter adds Claude Code
identity headers and OAuth-specific tool-name transformations. These are substantial
compatibility obligations, not a simpler public authentication interface.
[Credential implementation](https://github.com/NousResearch/hermes-agent/blob/602d76a72d1597b68f6def0c61ca6ac7802a92fb/agent/anthropic_credentials.py),
[Messages adapter](https://github.com/NousResearch/hermes-agent/blob/602d76a72d1597b68f6def0c61ca6ac7802a92fb/agent/anthropic_adapter.py)

The official experimental `claude-subscription-directsdk` plugin is closer to
Veduta's architecture: it drives the unmodified CLI while Hermes retains its loop,
tools, approvals and compaction. It owns no Claude credentials. Despite its name,
it uses raw stream-json rather than depending on the Python Agent SDK.
[Catalog pin](https://github.com/NousResearch/hermes-agent/blob/602d76a72d1597b68f6def0c61ca6ac7802a92fb/plugin-catalog/claude-subscription-directsdk.yaml)

The plugin's faithful native tool/history transport uses inert MCP definitions,
stream-json replay, and a local admission relay. Its README describes native
version-sensitive behavior and warns that `--max-turns 1` can still cause multiple
upstream generations. It therefore qualifies this as experimental. A tool-free
structured envelope is a smaller Veduta adapter, at the cost of serializing history
as supplied prompt data instead of preserving native signed replay.
[Plugin design and limitations](https://github.com/NousResearch/hermes-official-plugins/blob/6dacaaddbfd8e98dfc524096c44f712f743246b8/claude-subscription-directsdk/README.md),
[Transport source](https://github.com/NousResearch/hermes-official-plugins/blob/6dacaaddbfd8e98dfc524096c44f712f743246b8/claude-subscription-directsdk/directsdk.py)

The plugin independently uses the raw initialize handshake for model discovery.
It notes that disabling Claude feature-flag traffic can shrink the account's model
menu. [Setup and discovery](https://github.com/NousResearch/hermes-official-plugins/blob/6dacaaddbfd8e98dfc524096c44f712f743246b8/claude-subscription-directsdk/directsdk_setup.py)

## Minimal Veduta implementation boundary

The proposed request-scoped adapter is an implementation inference, to be verified
with the exact pinned CLI rather than presented as a provider-native arbitrary-tool
protocol:

1. Reuse the existing Model connection lifecycle and secret-free status projection.
   Store the connection's private CLI directory reference; let CLI login/logout
   manage its contents. Resume or reauthorize an interrupted setup truthfully.
2. Start a fresh inference process in a private empty working directory. Disable
   hooks, setting sources, slash commands, native tools, MCP tools and persistence;
   retain OAuth authentication. Validate startup and refuse unexpected native tools.
3. Supply Veduta's system context, canonical conversation, allowed `ToolDef`
   definitions and results. Require a schema-validated envelope containing text
   and requested tool calls. Only the normal AgentRunner validation/execution path
   can accept those requests and commit their outcomes.
4. Treat malformed output, unknown tools, invalid arguments, login expiry,
   subscription limits, cancellation and process failure as explicit typed failures.
   Never switch billing methods or replay an accepted effect implicitly.
5. Require runtime proof of an actual Surface operation and follow-up tool result,
   refresh/restart, separate account isolation, denied/expired setup, quota handling
   and cancellation before claiming parity.

`--json-schema` yields `structured_output` after completion and can retry invalid
generation. Its schema support includes nested objects and references, but
`format` is an annotation rather than validation. Veduta must still validate
its own envelope and tool arguments. [Structured-output contract](https://code.claude.com/docs/en/agent-sdk/structured-outputs)

The CLI supports JSON/stream-json output, stdin prompts, and disabled session
persistence. Noninteractive failures can be result envelopes on stdout. Stdin is
bounded at 10 MB; use an adapter input bound before spawning. A tool-free call
may still have native structured-output retries, so distinguish one Veduta model
call from one HTTP request. [Programmatic CLI](https://code.claude.com/docs/en/headless)

This research establishes viable login and catalog mechanics and the current
documented binary boundary. Real account authentication, allowance availability,
inference, Surface authoring and the completed Veduta implementation remain separate
verification work.
