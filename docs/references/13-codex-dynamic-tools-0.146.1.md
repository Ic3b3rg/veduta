# Codex app-server 0.146.1 dynamic-tool protocol capture

Date: 2026-08-11

Scope: the experimental dynamic-tool boundary used by issue
[071](../../issues/071-codex-dynamic-tool-round-trip.md). This is a sanitized protocol record,
not an authorization or account-data capture.

## Method

The exact `@openai/codex@0.146.1` package was installed in a temporary directory outside this
repository. Its app-server JSON Schema was generated with:

```text
codex app-server generate-json-schema --experimental
```

A temporary `CODEX_HOME` with mode `0700` received a copy of an existing local authorization file.
The app-server was initialized with the experimental API capability, then driven over stdio through
one harmless `echo_value` dynamic tool. Success, handler-failure, and interruption paths were
observed. The unfinished capture turn was interrupted, the child was stopped, and the temporary
install, schema output, authorization copy, and `CODEX_HOME` were deleted. No credential, account
identifier, model catalog, usage limit, or rate-limit value was retained here.

## Generated-schema facts

- `InitializeCapabilities.experimentalApi` is a boolean and defaults to `false`.
- A `DynamicToolSpec` requires `type: "function"`, `name`, `description`, and `inputSchema`;
  `deferLoading` is optional.
- `DynamicToolCallParams` requires `threadId`, `turnId`, `callId`, `tool`, and `arguments`.
  `namespace` is optional and nullable. `arguments` accepts JSON.
- The reverse JSON-RPC request id is `RequestId`, whose schema permits a string or signed 64-bit
  integer.
- `DynamicToolCallResponse` requires `success` and `contentItems`. Output items are discriminated
  as `inputText { text }`, `inputImage { imageUrl }`, or `inputAudio { audioUrl }`.

## Definition and turn start

The client opted in during `initialize`; omitting this capability does not expose the experimental
dynamic-tool request:

```json
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "veduta-protocol-capture", "version": "0.0.0" },
    "capabilities": { "experimentalApi": true }
  }
}
```

The observed response contained the four fields already used for version pinning. Values below are
sanitized:

```json
{
  "id": 1,
  "result": {
    "userAgent": "<client/0.146.1; platform sanitized>",
    "codexHome": "<scratch-codex-home>",
    "platformFamily": "<platform-family>",
    "platformOs": "<platform-os>"
  }
}
```

`dynamicTools` was sent on `thread/start`, alongside the restrictions retained by production:

```json
{
  "id": 2,
  "method": "thread/start",
  "params": {
    "model": "<selected-codex-model>",
    "approvalPolicy": "never",
    "sandbox": "read-only",
    "config": { "web_search": "disabled", "disabled_tools": true },
    "cwd": "<scratch-codex-home>",
    "dynamicTools": [
      {
        "type": "function",
        "name": "echo_value",
        "description": "Echo a value.",
        "inputSchema": {
          "type": "object",
          "properties": { "value": { "type": "string" } },
          "required": ["value"],
          "additionalProperties": false
        }
      }
    ]
  }
}
```

The response returned `thread.id`. `turn/start` then used that id and an input array:

```json
{
  "id": 3,
  "method": "turn/start",
  "params": {
    "threadId": "<thread-id>",
    "input": [{ "type": "text", "text": "Call echo_value with veduta-round-trip." }]
  }
}
```

The response returned `turn.id`.

## Call and correlation

The app-server first emitted an `item/started` notification. The dynamic item carried the semantic
call identity and structured arguments:

```json
{
  "method": "item/started",
  "params": {
    "threadId": "<thread-id>",
    "turnId": "<turn-id>",
    "item": {
      "type": "dynamicToolCall",
      "id": "<dynamic-item-id>",
      "namespace": null,
      "tool": "echo_value",
      "arguments": { "value": "veduta-round-trip" },
      "status": "inProgress",
      "contentItems": null,
      "success": null,
      "durationMs": null
    }
  }
}
```

It then issued a child-to-client JSON-RPC request:

```json
{
  "method": "item/tool/call",
  "id": 0,
  "params": {
    "threadId": "<thread-id>",
    "turnId": "<turn-id>",
    "callId": "<dynamic-item-id>",
    "namespace": null,
    "tool": "echo_value",
    "arguments": { "value": "veduta-round-trip" }
  }
}
```

Three identifier domains are distinct:

1. Client-to-server requests have client-owned JSON-RPC ids (`1`, `2`, `3`, ...).
2. `item/tool/call.id` is the server-owned reverse-request id. It must be echoed by the response.
3. `params.callId` is the semantic tool-call id preserved through AgentRunner and the session.

The capture deliberately observed reverse id `0`; client and server numeric id spaces can overlap,
so direction and the presence of `method` must distinguish them. Neither JSON-RPC id may be
substituted for `callId`.

## Result and same-turn continuation

The successful result was a JSON-RPC response on the reverse-request id. There was no separate
tool-result method and no second `turn/start`:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "success": true,
    "contentItems": [{ "type": "inputText", "text": "veduta-round-trip" }]
  }
}
```

The same turn then emitted `item/completed` for the dynamic item with `status: "completed"`,
`success: true`, and the returned `contentItems`. Normal assistant deltas followed through
`item/agentMessage/delta`, and the terminal notification was:

```json
{
  "method": "turn/completed",
  "params": {
    "threadId": "<thread-id>",
    "turn": { "id": "<turn-id>", "status": "completed" }
  }
}
```

This establishes that PiAgentRunner's repeated model-call loop must resume the suspended transport
turn: it executes the handler between calls, while the adapter answers the pending reverse request
and continues reading the original thread and turn.

## Handler failure

A failed handler used the same response mechanism and content-item shape:

```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": {
    "success": false,
    "contentItems": [{ "type": "inputText", "text": "sanitized tool failure" }]
  }
}
```

The dynamic `item/completed` then carried `status: "failed"` and `success: false`. The app-server
did not terminate the provider turn: it produced a final assistant message and a completed turn.
Production therefore sends Pi's `ToolResultMessage.isError` as `success: false`; it does not throw
away the tool result or start a replacement turn.

## Cancellation

Cancellation used the already-observed interrupt method with both correlation ids:

```json
{
  "id": 4,
  "method": "turn/interrupt",
  "params": { "threadId": "<thread-id>", "turnId": "<turn-id>" }
}
```

The response result was `{}`. The terminal notification retained the same thread and turn ids and
reported `turn.status: "interrupted"`.

## Production interpretation

The zod schemas in `packages/daemon/src/codex-app-server-protocol.ts` require every field on which
correlation or execution depends and use non-strict objects so unknown additive fields are inert.
`packages/daemon/src/codex-app-server.ts` separates reverse requests from outbound responses before
looking up numeric ids. `packages/daemon/src/model-connection-codex.ts` translates only definitions,
calls, results, and text. Tool validation, handler execution, trust context, session persistence,
and normalized events stay in `PiAgentRunner`.
