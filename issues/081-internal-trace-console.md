# 081 — Internal trace console: locate runtime problems and errors

## Context

When Veduta is slow, stuck, or unsuccessful, the user currently has to combine chat output, Space
Event logs, session data, usage files, and `journalctl` to infer what happened. Those records have
different purposes and do not provide one reliable end-to-end correlation path.

[ADR-0017](../docs/adr/0017-bounded-local-diagnostics.md) introduces bounded non-canonical Traces
and Runtime logs without weakening the Event log, security audit, or session contracts. The
delivery constraints below are grounded by research into
[Hermes](../docs/references/09-hermes-human-observability.md) and
[operator consoles](../docs/references/10-operator-log-trace-interfaces.md).

## Goal

From one authenticated read-only PWA page, a user can determine whether a runtime problem occurred
and identify the meaningful model, tool, Surface, Event log, delivery, or Gateway step responsible,
without routinely entering the VPS.

## What to build

- Add a Gateway-owned Trace contract that generates a server-side `traceId` at chat, fast-path,
  Automation, Worker, notification, update, and external-event boundaries. Correlate only
  meaningful operational steps: model attempts and failover, tools, approvals, Surface mutations,
  Event log appends, external calls, and terminal outcomes. Ordinary functions and token deltas
  stay in Runtime logs.
- Persist redacted append-only Activity JSONL in 5 MB segments for at most 30 days or 200 MB, and
  maintain a separate disposable SQLite index that accelerates simple search and filters while
  always dereferencing and validating the original line. Recording and indexing fail open with an
  explicit gap; neither may fail the product operation being observed.
- Replace first-party ad-hoc operational output with one structured Runtime logger that records
  DEBUG, INFO, WARN, and ERROR to `journald` and ten rotating 5 MB JSONL segments retained for at
  most seven days. Preserve the existing rule that sensitive child-process stderr and raw provider
  envelopes are not logged.
- Apply secret redaction before queuing, persistence, indexing, streaming, or export. Never retain
  credentials, passkey/session material, full provider HTTP envelopes, the system prompt, or the
  complete model context. Reference session transcript entries instead of duplicating them. Bound
  tool/result/reasoning detail to 64 KiB and mark every truncation.
- Expose authenticated, no-store, paginated read APIs for Activity summaries, Trace detail, Runtime
  segment inventory, and one 5 MB Runtime segment. Activity supports plain text plus time, Space,
  session, component, status, and `traceId` filters; it does not implement a query language.
- Add a dedicated authenticated `/ws/trace` channel so Runtime bursts cannot interfere with chat.
  It streams only the active view, replays retained records from an opaque cursor, and makes loss,
  rotation, reconnect, and backpressure gaps explicit.
- Add the hidden `/app/trace` PWA route with **Activity** and **Runtime logs** views. Activity uses a
  dense chronological list and minimal selected-Trace inspector; Runtime logs use a terminal-like
  retained/live stream. A single `Real-time logs` checkbox starts unchecked and is the only control
  that opens the WebSocket.
- Keep the page strictly read-only. Permit search, filters, pause, copy, and download of already
  redacted loaded data; do not add commands, retry, restart, configuration, retention, clear, or
  delete controls. On mobile, keep the list full-width and open details full-screen.
- Document the hard-down fallback: after a normal restart, retained diagnostics return to the PWA;
  if the Gateway cannot start, the operator uses exact `journalctl` and retained Runtime-file
  commands over SSH. Do not add a recovery sidecar or second viewer.

## Contract constraints

- Keep five focused responsibilities behind the feature: `TraceContext` propagates correlation,
  `TraceRecorder` redacts and bounds events without failing product work, `TraceStore` owns retained
  segments and the disposable index, `RuntimeLogger` owns technical output, and `TraceReader` owns
  authenticated read-only delivery.
- The Gateway generates every `traceId` and `stepId`. In-process propagation may use
  `AsyncLocalStorage`; durable work that outlives its initiator starts a new root Trace and may carry
  a `parentTraceId` instead of retaining an in-memory context indefinitely.
- Define every Gateway-to-PWA record in `@veduta/protocol` with a versioned envelope. Known model,
  tool, Surface, Event log, approval, delivery, and lifecycle details use discriminated schemas.
  Unknown additive event families render visibly from their safe envelope instead of crashing or
  disappearing.
- Derive root status from start and terminal events. A recovered failed attempt remains an error
  step inside a root that may complete; missing provider usage or reasoning remains absent.
- Use `GET /api/trace-events`, `GET /api/traces/:traceId`,
  `GET /api/runtime-log-segments`, `GET /api/runtime-log-segments/:segmentId`, and a separate
  `/ws/trace` channel. Filesystem paths and credentials never cross those interfaces.
- Represent queue saturation, partial final lines, rotated cursors, index corruption, sink failure,
  and slow live clients as explicit bounded gaps or degraded states. Diagnostics may be incomplete,
  but may not report completeness that was not observed.

## Acceptance criteria

- [ ] **Locate the failure:** an end-to-end chat fixture containing model work, a tool, a Surface
      mutation, and an Event log append appears under one `traceId`; injected model, tool,
      delivery, and final-turn failures identify the exact failed step and retain retry/failover
      evidence.
- [ ] **Truthful optional data:** missing provider token, cost, or reasoning fields remain absent;
      provider-emitted values appear only on their originating model step and are never presented
      as effect verification.
- [ ] **Safe durable output:** sentinel credentials and nested sensitive values are absent from
      Activity/Runtime JSONL, the disposable index, `journald`, REST, WebSocket, copy, and download;
      details over 64 KiB are visibly truncated with byte metadata.
- [ ] **Fail-open diagnostics:** injected file, index, and queue failures do not fail the observed
      chat, tool, Surface, or Event log path; the page and retained records expose DEGRADED or an
      exact gap instead of silently claiming completeness.
- [ ] **Bounded retention:** deterministic fixtures prove 5 MB segmentation, Activity's 30-day or
      200 MB ceiling, Runtime's ten-segment/50 MB and seven-day ceiling, oldest-complete-segment
      deletion, active-segment preservation, and `0700`/`0600` permissions.
- [ ] **Disposable validated index:** deleting, corrupting, truncating, or restoring the Activity
      index rebuilds from retained JSONL; every detail dereference verifies source identity, and a
      missing or changed source renders as a gap rather than the wrong event.
- [ ] **Read boundary:** unauthenticated REST and WebSocket clients receive no diagnostics, session
      revocation closes a live socket, credentials never enter URLs, responses are `no-store`, and
      pagination plus opaque-cursor replay cannot return unbounded data.
- [ ] **Minimal Activity UX:** the hidden direct route is absent from ordinary navigation; Activity
      has simple search and explicit filters, accessible blue-running/green-completed/red-error
      indicators, one status dot in the inspector, and conditional step details without empty or
      invented fields.
- [ ] **Runtime UX:** all four levels are visible without filters, the newest 5 MB block loads first,
      older retained blocks load progressively, scrolling or inspecting pauses follow mode, and
      the unseen count, reconnect state, rotation boundaries, and data gaps are explicit.
- [ ] **Opt-in realtime:** `Real-time logs` is unchecked on entry, no Trace socket exists while it
      is off, enabling it subscribes only to the active view, switching views replaces the
      subscription, and disabling it leaves the current historical position intact.
- [ ] **Restart and hard-down evidence:** a smoke test proves retained diagnostics survive a
      Gateway restart; operations documentation verifies the exact `journalctl` and Runtime-file
      commands for a Gateway that cannot start and states that no external recovery viewer exists.
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, and `pnpm build` pass.

## Out of scope

- Query languages, saved searches, configurable columns, aggregate operational overviews,
  alerting, metrics, or OpenTelemetry/exporter integration.
- Commands, reruns, retries, Gateway restart, configuration editing, retention controls, or log
  deletion from the PWA.
- Capturing every internal function, token delta, raw provider envelope, system prompt, complete
  model context, or deliberately suppressed child-process stderr.
- An always-on or temporary recovery viewer, sidecar, second PWA origin, or public diagnostic
  endpoint.

## Blocked by

None — builds on completed issues [004](004-gateway.md), [005](005-auth-tls-passkey.md),
[009](009-pwa-home-chat.md), [015](015-security-hardening.md), and
[037](037-agent-loop-chat.md), and on
[ADR-0017](../docs/adr/0017-bounded-local-diagnostics.md).

## Implementation tickets

- #82 through #90.

## Parent completion criteria

- [ ] Issues #82 through #90 are complete.
- [ ] The hidden console provides the bounded, redacted, restart-safe diagnostic path specified
      here without becoming canonical product state.
- [ ] The full repository gate and diagnostic recovery evidence are green.
