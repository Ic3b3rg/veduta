# Codex 0.160.0 compatibility and Model connection recovery

Maintenance follow-up: [#203](https://github.com/Ic3b3rg/veduta/issues/203).

Checked on 2026-10-04 against the real Codex 0.160.0 app-server on macOS arm64, using an
already-authorized ChatGPT Model connection in an isolated temporary `CODEX_HOME`.
The temporary credential copy and app-server state were removed after the check.

This updates the exact dependency pin established by [ADR-0014](../adr/0014-subscription-inference-boundary.md)
and the Model connection contract in [issue #47](https://github.com/Ic3b3rg/veduta/issues/47).
It does not change the inference-only boundary, provider-native tool refusals, or fallback policy.

## Observed compatibility

- `initialize` accepted Veduta's `experimentalApi` capability and returned the existing
  `userAgent`, `codexHome`, `platformFamily`, and `platformOs` shape, with version 0.160.0.
- `account/read` recognized the existing managed ChatGPT authorization without another login.
- `model/list` passed the existing response schema and returned `gpt-6.1-sol`, `gpt-6-astra`,
  `gpt-6-sol`, and `gpt-6-luna`, alongside the still-visible older models.
- A real `gpt-6.1-sol` turn used Veduta's existing `thread/start` isolation parameters, invoked
  one caller-defined dynamic tool, suspended for its result, and completed through
  `streamCodexToolTurn`. The tool had no side effects and returned one fixed string.
- No consumed response or notification schema needed changing. The compatibility check did not
  initiate a new device authorization or test provider-side logout.

The [official app-server documentation](https://learn.chatgpt.com/docs/app-server#list-models-modellist)
specifies discovery through `model/list`: available models and defaults depend on the client and
account. Veduta must use that returned catalog rather than inject model names from the API catalog.

## Catalog freshness

The 0.146.1 connection's cache was freshly fetched on the same day but contained no 6.x model.
Codex 0.160.0 returned the current 6.x models for the same authorized connection. This distinguishes
a client-version restriction from an old Veduta catalog snapshot.

Veduta already refreshes the catalog whenever a Model connection refresh succeeds, including the
pre-inference freshness check. A newer upstream model becomes visible when the supported client
and account expose it. Updating the Codex executable remains a tested, exactly pinned dependency
upgrade; replacing it with an unchecked latest version would bypass the reviewed protocol boundary.

## Restoring a conversation after replacing a Model connection

The affected durable Agent sessions still carried a model-change entry for a removed connection.
`PiAgentRunner.start` tried to resolve that historical model before the chat loop could pass the
newly selected one. Session loading now restores the branch without constructing a provider
Agent; the next prompt resolves its current routed Model connection and rebuilds the Agent with
the existing history. An unavailable selected connection still fails before inference.

A clean disposable daemon and PWA were also checked through the browser with the real managed
0.160.0 executable. A durable global session referenced the removed connection and contained a
remembered word. The chat returned that word through the newly selected `gpt-6.1-sol` connection;
after a daemon restart and page reload, a second turn retained it. The Models page showed the
connected account and the current 6.x catalog. The fixture used development authentication;
it did not change or bypass the live instance's passkey authentication. Its data and credential
copy were removed after verification.

To repeat the recovery check in a disposable authenticated install:

1. Connect ChatGPT, select a model, and ask the chat to remember a distinctive word.
2. Remove that Model connection, connect ChatGPT again, and select the new connection's model.
3. Ask for the remembered word in the same chat. The reply must preserve the earlier context
   without a missing-connection error.
4. Restart the daemon, reload the page, and repeat the question. In Models, confirm the connected
   state and the catalog returned for the supported Codex client and account.
