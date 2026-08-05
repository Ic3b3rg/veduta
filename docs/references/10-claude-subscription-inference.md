# Research 10 — Claude subscription inference through the Agent SDK

> Conducted on 2026-08-05 against current Anthropic documentation and the official TypeScript
> Agent SDK package. This resolves
> [Verify the supported Claude subscription inference path](https://github.com/Ic3b3rg/veduta/issues/51)
> for the canonical
> [Model connections](https://github.com/Ic3b3rg/veduta/issues/47) specification.

## Decision

**There is no publicly supported Anthropic path that satisfies the Claude-subscription journey
in Model connections as written.** Veduta must not ship a Claude.ai login, route a user's Free,
Pro, or Max credential through the Gateway, or reproduce Anthropic's OAuth client unless
Anthropic first approves the integration.

Anthropic recognizes ordinary individual subscription use of Claude Code and the Claude Agent
SDK, but separately says that third-party developers may not offer Claude.ai login or route
subscription credentials on behalf of users. The restriction explicitly includes products
built with the Agent SDK and may be enforced without notice
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview),
[legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). A self-hosted
Veduta installation is still a login flow offered by a third-party product; treating it
otherwise would be an inference only Anthropic can confirm.

The supportable product behavior today is therefore:

1. expose the Claude subscription adapter as unavailable with the precise approval requirement;
2. retain Anthropic API-key or supported cloud-provider authentication for API-backed use; and
3. re-open the subscription design only after written Anthropic approval or new public OAuth
   integration documentation.

## Exact client and boundary

The official TypeScript agent client is
[`@anthropic-ai/claude-agent-sdk`](https://code.claude.com/docs/en/agent-sdk/typescript). Its
`query()` function starts a bundled `claude` subprocess, and that subprocess owns an agent loop,
local sessions, filesystem state, and tool execution
([hosting model](https://code.claude.com/docs/en/agent-sdk/hosting)). It streams SDK messages and
can be made tool-less, but Anthropic does not document it as a raw inference transport to nest
inside another loop. Adapting a tool-less `query()` call behind `AgentRunner` is therefore a
Veduta-specific integration, not a drop-in provider API.

The official raw inference client is
[`@anthropic-ai/sdk`](https://platform.claude.com/docs/en/api/client-sdks), using the Messages API.
That shape fits an `AgentRunner` provider boundary, but the Claude API accepts API keys or
Workload Identity Federation, not consumer Claude subscriptions
([Claude API authentication](https://platform.claude.com/docs/en/manage-claude/authentication)).
Workload Identity Federation removes a static API key but remains separately metered commercial
API access; it is not a way to spend a Pro or Max subscription.

This leaves no client/authentication combination that is simultaneously all of the following:

- subscription-backed;
- publicly permitted for a third-party product;
- initiated and completed inside Veduta's PWA; and
- a stable raw inference interface behind `AgentRunner`.

## Authorization flows

| Flow                         | Anthropic documents                                                                                                                                                            | Fit for Model connections                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Saved Claude Code login      | `claude`, `/login`, or `claude auth login` opens browser OAuth and stores a refreshable login. Pro, Max, Team, and Enterprise accounts are accepted.                           | Supported for Claude Code and ordinary individual use, but not a public third-party login contract.                                                          |
| Remote login code            | On SSH, WSL2, or in a container, the browser may show a code when it cannot reach the CLI's localhost callback. The user pastes it into `claude auth login` on standard input. | A shell fallback, not a PWA callback/code API. Proxying it through the PWA is undocumented and prohibited absent approval.                                   |
| `claude setup-token`         | Opens browser authorization, prints a one-year, inference-only token, and requires the caller to place it in `CLAUDE_CODE_OAUTH_TOKEN`.                                        | Official for CI/scripts, but exposes a raw token, requires terminal work, and has no documented refresh path. It correctly remains excluded from product UX. |
| API key or cloud provider    | Agent SDK quickstart and production-hosting guidance use `ANTHROPIC_API_KEY`, Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry.            | Publicly supported for products, but not backed by the user's Claude subscription.                                                                           |
| Veduta-owned Claude.ai OAuth | No public app registration, client credentials, authorization-start, callback-completion, token, or revoke API is documented for third-party products.                         | Unsupported. Reusing Anthropic's application identity would impersonate the provider application.                                                            |

The documented remote behavior is precise: copy the login URL to a browser on the local machine,
then paste the returned code into the remote CLI
([authentication](https://code.claude.com/docs/en/authentication),
[remote login troubleshooting](https://code.claude.com/docs/en/troubleshoot-install)). The
Agent SDK exposes an `SDKAuthStatusMessage` containing display output, but its public TypeScript
API exposes no structured method to start Claude.ai authorization or submit that code
([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)). Parsing CLI text
or forwarding PWA input into an interactive subprocess would be an unstable implementation
inference, even before the product-policy restriction is applied.

## Credential refresh, expiry, and revocation

Saved `/login` credentials are owned by Claude Code. On Linux they live in
`~/.claude/.credentials.json` with mode `0600`, relocatable with `CLAUDE_CONFIG_DIR`; Claude Code
coordinates automatic refresh between concurrent sessions. It warns shortly before a login
expires. If refresh fails or the credential is revoked, Agent SDK requests stop with structured
`authentication_failed`, and the user must log in again
([credential management](https://code.claude.com/docs/en/authentication),
[authentication errors](https://code.claude.com/docs/en/errors)). Anthropic does not publish a
stable credential-file schema, so copying that file's fields into Veduta's vault is not a
supported adapter contract.

`claude setup-token` is different: its one-year bearer token is not stored by the command and no
refresh mechanism is documented. It cannot satisfy automatic refresh.

The documented revocation surfaces are local CLI logout and the user's Claude Settings → Claude
Code token list. Removing a token there invalidates it at Anthropic
([account logout and Claude Code tokens](https://support.claude.com/en/articles/10310342-how-do-i-log-out-of-all-active-sessions)).
The Agent SDK has no documented logout or revoke method. A Veduta “remove connection” action
could stop using and erase local material, but it could not claim provider-side revocation.

Using a separate clean `CLAUDE_CONFIG_DIR` per connection could isolate multiple saved logins,
but that is a deployment composition inferred from the configuration-directory behavior, not a
documented multi-account registry or authorization API.

## Model catalog and provider tools

After a session initializes, the TypeScript Agent SDK's `Query.supportedModels()` returns
`ModelInfo[]` with selectable values and display metadata. This is the supported source for the
current SDK session's model picker. `/model` is likewise documented as showing models available
to the authenticated account, subject to provider availability and organization restrictions
([TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript),
[model configuration](https://code.claude.com/docs/en/model-config)).

Veduta could display every entry returned by `supportedModels()` if subscription integration
were approved. It must not describe that result as an exhaustive or stable “account catalog”:
entries include aliases, availability changes, and admin allowlists can filter the result. The
Claude API's separate `GET /v1/models` catalog requires API authentication and is not a
subscription-OAuth substitute
([Models API](https://platform.claude.com/docs/en/api/models/list)).

Disabling Agent SDK tools is documented and feasible. `tools: []` removes all built-in tools;
`allowedTools: []` alone does **not**, because it controls permission rather than availability
([custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools),
[permissions](https://code.claude.com/docs/en/agent-sdk/permissions)). A defensible tool-less
adapter must also use an empty MCP configuration with `strictMcpConfig: true`, pass
`settingSources: []` and `skills: []`, use a clean `CLAUDE_CONFIG_DIR`, and disable auto memory so
user/project settings, MCP servers, plugins, skills, and memory do not silently expand the
provider surface. Because managed policy remains outside `settingSources`, the adapter must also
fail closed unless the SDK's initialization message reports an empty tool list
([Claude Code features in the SDK](https://code.claude.com/docs/en/agent-sdk/claude-code-features),
[secure hosting isolation](https://code.claude.com/docs/en/agent-sdk/hosting)). This answers the
tool-control question but does not change the authorization decision.

## Usage restrictions and instability

As of this review, Agent SDK and `claude -p` use can draw from a subscriber's plan limits.
Anthropic paused a previously announced change to separate Agent SDK credits and explicitly says
it is still redesigning this policy
([current Agent SDK plan notice](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)).
The legal guidance limits Pro and Max allowances to ordinary individual use.

That plan notice mentions metering for “third-party app usage,” while the more specific current
Agent SDK and legal pages prohibit third-party Claude.ai login without prior approval. The
billing statement proves that such traffic can exist; it does not publish an OAuth integration
contract or override the explicit approval boundary. This first-party inconsistency is another
reason not to infer permission from observed token behavior.

Subscription credentials also do not guarantee that every request remains inside the included
monthly price. If a subscriber has enabled usage credits, activity can continue at metered rates
after included limits are exhausted
([Pro and Max usage](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)).
That is not a switch to a Veduta BYOK connection, but it disproves the stronger assumption that a
connection labelled “Subscription” can never incur metered usage. The SDK's dollar estimates are
not authoritative billing data
([Agent SDK cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)).

These policies and model entitlements are actively changing. Any future implementation must
re-check Anthropic's legal, authentication, and plan pages rather than treating this report as a
permanent protocol specification.

## Audit of Model connections assumptions

| Assumption in the canonical issue                                          | Finding                                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| A Gateway-managed Agent SDK adapter may route a user's Claude subscription | Technically possible in user-controlled contexts, but not publicly permitted for a third-party product without prior approval.        |
| Authorization can start in the PWA                                         | Unsupported; the public flow starts in Claude Code/CLI.                                                                               |
| The PWA can accept the remote authorization code                           | Unsupported; pasted-code behavior is documented only for CLI standard input, with no structured Agent SDK completion API.             |
| No token or terminal step needs to be exposed                              | Not achievable with documented public flows. Saved login requires Claude Code interaction; `setup-token` requires both.               |
| Subscription credentials refresh automatically                             | True only for Claude Code's saved login while its refresh remains valid. False for the documented one-year setup token.               |
| Veduta can revoke the provider credential through an adapter               | Unsupported; provider revocation lives in Claude Settings and no SDK revoke API is documented.                                        |
| Veduta's encrypted vault can own the refresh lifecycle                     | Unsupported; Claude Code owns an opaque credential store, while the documented automation alternative is an environment bearer token. |
| Multiple Claude accounts are a supported SDK concept                       | No. Separate `CLAUDE_CONFIG_DIR` values are a plausible isolation technique, not a documented account registry.                       |
| A full, stable account model catalog is available                          | Partly. `supportedModels()` provides a current selectable snapshot; completeness and stability are not guaranteed.                    |
| Provider tools can be disabled                                             | Yes, with availability controls and isolation settings; `allowedTools` alone is insufficient.                                         |
| Subscription means no metered spend                                        | False when the subscriber has enabled usage credits; billing policy is also under active revision.                                    |
| `setup-token` should not be normalized into product UX                     | Confirmed. It is official but fails the issue's UX, refresh, and third-party approval requirements.                                   |

## Consequence for the route forward

The Claude acceptance criterion in Model connections is blocked by an external provider-policy
decision, not by missing implementation detail. The implementation-ready specification should
make the adapter conditionally available only when Veduta can point to an Anthropic approval or a
new public third-party OAuth contract. Until then, implementing the PWA flow would encode an
unsupported and explicitly unstable premise.
