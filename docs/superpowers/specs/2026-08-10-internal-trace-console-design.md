# Internal trace console design

Date: 2026-08-10
Status: approved for written-spec review
Decision: [ADR-0017](../../adr/0017-bounded-local-diagnostics.md)
Delivery: [issue 050](../../../issues/050-internal-trace-console.md)

## Outcome

When Veduta behaves incorrectly, the user must be able to determine in a few seconds whether a
problem occurred and at which meaningful step. The solution is a hidden, passkey-protected,
read-only PWA console at `/app/trace` backed by bounded local diagnostic files.

The feature must answer four questions:

1. What is Veduta doing now?
2. Why was one operation slow, stuck, or unsuccessful?
3. Which model, tool, Surface mutation, Event log append, or external call participated?
4. Can one operation be followed end to end through a single `traceId` without entering the VPS?

This is a debugger for one self-hosted installation, not a general observability platform.

## Scope ceiling

The first version includes:

- one global Activity list with simple search and filters;
- one minimal inspector for the selected Trace;
- retained Runtime logs and opt-in realtime delivery;
- end-to-end correlation across chat, model attempts, tools, approvals, Surface mutations, Event
  log appends, Automations, Workers, notifications, updates, and errors;
- copy and local download of data that has already been redacted.

It excludes aggregate operational overviews, alerting, metrics, configurable charts, a query
language, saved searches, custom columns, OpenTelemetry, external collectors, log mutation,
administrative commands, retry buttons, and an out-of-process recovery viewer.

## Records and responsibilities

| Record                 | Purpose                                                         | Canonical? |
| ---------------------- | --------------------------------------------------------------- | ---------- |
| Space Event log        | User-visible domain events and Agent provenance                 | Yes        |
| Security audit         | L1+ effects, approvals, allowlist changes, and their provenance | Yes        |
| Session store          | Conversation messages, tool calls/results, and model changes    | Yes        |
| Trace                  | Bounded explanation of one operation and its meaningful steps   | No         |
| Runtime log            | Installation-wide technical diagnostics                         | No         |
| Disposable Trace index | Search metadata and source positions for retained Trace records | No         |

Trace recording never substitutes for an Event log append, a security audit row, session
persistence, or effect verification. Provider reasoning is optional diagnostic text, not an
accountability record.

## Architecture and data flow

```text
PWA message / Automation / Worker / external event
                       │
              server creates traceId
                       │
             TraceContext (in process)
                       │
     AgentRunner · tools · Surface engine · Event log
                       │ structured events
                       ▼
                 TraceRecorder
               redact → bound → append
                  │             │
                  ▼             ▼
       Activity JSONL       live broker
                  │             │
          disposable index      └── /ws/trace when opted in
                  │
                  └── authenticated REST reader

RuntimeLogger ── redact → Runtime JSONL + journald + live broker
```

Five focused modules own this path:

- **TraceContext** generates and propagates correlation state.
- **TraceRecorder** accepts typed events, redacts and bounds them, and never throws into observed
  product work.
- **TraceStore** owns append, rotation, retention, reconciliation, and the disposable index.
- **RuntimeLogger** emits structured technical records to rotating files and `journald`.
- **TraceReader** exposes authenticated retained records and realtime subscriptions without
  mutation.

The PWA only renders protocol records. It does not reconstruct Traces by joining unrelated APIs.
The Agent and Workers continue to see only Veduta's `AgentRunner`, `ModelRef`, `ToolDef`, and
`SessionStore` contracts; no new direct `pi-agent-core` import is allowed.

## Trace context and lifecycle

The Gateway generates every `traceId`; an untrusted client cannot choose or override it. A root
Trace begins at a product boundary such as a chat turn, Automation occurrence, Worker run,
notification delivery, update operation, or fast-path interaction.

In-process propagation uses a request-local `TraceContext` backed by Node's `AsyncLocalStorage`.
Meaningful child work receives a server-generated `stepId` and the current parent step. Durable
work that outlives the initiating operation starts a new root Trace and may carry a
`parentTraceId`; it never keeps an in-memory context alive indefinitely.

Only meaningful operational boundaries become steps:

- model attempt, retry, or failover;
- tool execution;
- approval wait and resolution;
- Surface mutation;
- Event log append;
- external request or delivery;
- Automation or Worker handoff;
- operation completion or failure.

Text token deltas, ordinary function calls, framework callbacks, and polling iterations remain
Runtime log detail. This keeps the inspector short and prevents instrumentation from becoming the
product.

## Protocol contract

Everything crossing Gateway-to-PWA boundaries is defined and validated in `@veduta/protocol`.
Each append-only Trace record has a stable envelope:

| Field             | Contract                                                                       |
| ----------------- | ------------------------------------------------------------------------------ |
| `schemaVersion`   | Integer format version; version 1 initially                                    |
| `eventId`         | Server-generated unique record identifier                                      |
| `traceId`         | Server-generated root correlation identifier                                   |
| `parentTraceId`   | Optional link for durable work that became another root Trace                  |
| `stepId`          | Identifier of the meaningful step represented by the event                     |
| `parentStepId`    | Optional parent within the same Trace                                          |
| `at`              | Normalized ISO instant                                                         |
| `kind`            | Stable event name such as `step.started`, `step.completed`, or `step.failed`   |
| `operationKind`   | Root or step category, additive over time                                      |
| `component`       | Bounded human-readable emitter name                                            |
| `summary`         | Redacted one-line explanation, at most 512 UTF-8 bytes                         |
| scope identifiers | Optional `spaceId`, `sessionId`, `workerId`, Automation id, or external id     |
| `durationMs`      | Present on a terminal event when measured                                      |
| `details`         | Optional typed, redacted JSON; at most 64 KiB after serialization              |
| `truncation`      | Present when details were shortened; includes retained and pre-truncation size |

Known event families use discriminated schemas for model, tool, Surface, Event log, approval,
delivery, and lifecycle details. Additions are optional. A valid envelope with an event family
unknown to the current reader renders visibly as an unknown event with its safe summary; it never
crashes or disappears.

Status is derived rather than independently mutable:

- `RUNNING`: a start exists without a terminal event;
- `COMPLETED`: a terminal completion exists;
- `ERROR`: the selected step or root ended in failure.

A recovered failed attempt remains an ERROR step inside a Trace whose root may later complete.
Missing provider usage means unknown, never zero. Missing provider reasoning means absent, never a
generated substitute.

## Security and data minimization

Redaction happens before any diagnostic value enters a queue, file, index, WebSocket, or export.
The recorder reuses the process-wide secret registry and structural redactor and adds field-level
denials for authentication material.

The diagnostic stores must never contain:

- API keys, OAuth access or refresh tokens, cookies, Authorization headers, session tokens,
  pairing codes, passkey material, or vault values;
- complete provider HTTP request/response envelopes;
- the system prompt or the complete model context;
- raw child-process stderr that an adapter deliberately treats as sensitive.

The Trace stores references to session entries instead of duplicating a complete transcript. The
authenticated reader may resolve those entries on demand; unavailable content is shown as
unavailable rather than copied into the Trace. Tool input/result and provider-emitted reasoning may
be retained only after redaction and under the 64 KiB event-detail limit. Truncation is explicit,
and its byte counts describe the redacted serialization so raw secret-bearing data is never
measured into a durable field.

The PWA renders every message, error, stack, and JSON value as text through React. Diagnostic data
is never inserted as generated HTML and is never placed in the service-worker cache,
`localStorage`, or IndexedDB. REST responses and downloads use `Cache-Control: no-store`.

## Persistence, rotation, and indexing

All diagnostic storage lives under the configured Gateway data root with `0700` directories and
`0600` files.

### Activity

- Append-only JSONL segments rotate at 5 MB.
- Retention is at most 30 days or 200 MB, whichever limit is reached first.
- Cleanup removes only complete oldest segments; the active segment is never truncated in place.
- A final partial line after a crash is ignored and represented to readers as a diagnostic gap.

A dedicated SQLite index stores filterable metadata, redacted summary text, source position, and a
hash of the raw JSONL line. It never stores the full detail as truth. Dereference re-reads the line,
checks its hash, and validates the protocol schema. Missing or mismatched records return a visible
gap, never a different record.

The index is disposable. Boot reconciliation adds unindexed tails, removes references to rotated
segments, detects shortened or changed prefixes, and rebuilds on schema-version mismatch. Deleting
the index is a supported recovery and yields the same retained event ordering.

### Runtime logs

- Ten JSONL segments rotate at 5 MB each.
- Retention is at most 50 MB and seven days.
- The PWA loads one segment at a time, newest first, and can request older retained segments.
- The first version has no Runtime-log index or filters and shows DEBUG, INFO, WARN, and ERROR.
- Every first-party Runtime record also reaches `journald` in a concise redacted representation.

No compression, retention settings UI, or user-triggered deletion is included.

## Runtime logging contract

First-party Gateway diagnostics use one structured logger with timestamp, level, component,
message, optional `traceId`, and optional redacted error data. Fastify and external-adapter
diagnostics use allowlisted fields rather than raw headers, bodies, environments, or stderr.

Runtime collection is always active. The `Real-time logs` checkbox changes only delivery to the
browser. A failure in the rotating-file sink still permits the `journald` sink to report the
problem; diagnostic-sink failures use an emergency non-recursive console path.

Unhandled exceptions and rejections are recorded before preserving Node's normal termination
behavior. This feature does not swallow exceptions or turn a crash into apparent success.

## Read APIs and realtime channel

The read surface is intentionally small:

- `GET /api/trace-events` returns newest-first Activity summaries with an opaque cursor, a default
  page size of 100, and a maximum of 200.
- `GET /api/traces/:traceId` returns the selected Trace progressively when it exceeds one page.
- `GET /api/runtime-log-segments` returns retained segment metadata without filesystem paths.
- `GET /api/runtime-log-segments/:segmentId` returns one redacted segment, bounded by 5 MB.
- `/ws/trace` carries new Activity or Runtime records for the currently selected view.

Activity supports plain-text search plus explicit time range, Space, session, component, status,
and `traceId` filters. It has no query language. Runtime logs have no filters in the first version.

REST uses the existing Bearer-session hook. The dedicated WebSocket uses the same-origin check and
first-message session authentication as `/ws/gateway`; credentials never enter the URL. Revoking a
session closes its Trace socket. The Trace channel is separate so a log burst cannot delay chat or
Surface streaming.

The realtime socket does not exist while `Real-time logs` is unchecked. Checking it subscribes to
the active view; switching views replaces the subscription rather than streaming both. A bounded
per-client queue prevents a slow browser from applying backpressure to persistence. Reconnection
supplies the last opaque cursor: retained records replay, while rotated or dropped data produces an
explicit gap.

## PWA behavior

`/app/trace` is a manually entered deep link and is absent from ordinary navigation. The PWA shell
may load publicly like other `/app/*` routes, but no diagnostic data is available without the
normal passkey-backed session. Hidden navigation is not an authorization mechanism.

The page has two full-width views:

### Activity

- compact toolbar with plain search, time range, and explicit filters;
- restrained event-volume histogram;
- dense chronological rows with time, status, Space, component, summary, and duration;
- status uses one accessible compact indicator: animated blue ring for RUNNING, green dot for
  COMPLETED, and red dot for ERROR;
- selecting a row opens a minimal desktop inspector, or a full-screen detail layer on mobile;
- the inspector shows root status, start, duration, `traceId`, and observed steps;
- model, usage, tool details, errors, Surface changes, and provider reasoning appear only inside
  the step that actually supplied them; missing data creates no empty panel or invented value;
- the inspector header renders exactly one status indicator.

### Runtime logs

- terminal-like rows with timestamp, level, component, message, and correlated `traceId`;
- all four levels remain visible and there are no filters;
- newest retained 5 MB segment loads first, with progressive access to the other nine;
- following pauses when the user scrolls or selects details, preserves the viewport, and reports
  unseen-record count;
- copy operates on a row or selected detail; download exports only the currently loaded redacted
  Activity records or Runtime segment.

The realtime control is one unchecked `Real-time logs` checkbox shared by both views. The console
distinguishes historical-only, LIVE, PAUSED, RECONNECTING, OFFLINE, DEGRADED, and INDEXING states.
Rotation, reconnect, corruption, and loss are visible rows rather than silent transitions.

The page is strictly read-only. It cannot execute commands, rerun an operation, retry a tool,
restart the Gateway, mutate configuration, clear files, change retention, or delete records.

## Failure semantics

Trace and Runtime diagnostics are best-effort. They may be incomplete, but they may not become a
new reason product work fails.

| Failure                                 | Required behavior                                                       |
| --------------------------------------- | ----------------------------------------------------------------------- |
| Trace queue is saturated                | Drop bounded diagnostic detail, count it, then append an explicit gap   |
| Activity file append fails              | Continue observed work; report DEGRADED through Runtime/journald        |
| Runtime file append fails               | Continue observed work; report through the non-recursive journald sink  |
| Disposable index fails                  | Keep JSONL; report INDEXING/DEGRADED and reconcile or rebuild           |
| Final JSONL line is partial             | Ignore it safely and expose a gap                                       |
| Browser falls behind                    | Disconnect or gap the live queue; recover from retained cursor data     |
| Cursor points to rotated data           | Return an explicit `events no longer retained` boundary                 |
| Unknown additive event                  | Render an unknown-event row and safe raw envelope                       |
| Gateway crashes and systemd restarts it | Retained files remain and become readable after restart                 |
| Gateway cannot start                    | Use documented `journalctl` and retained Runtime-file commands over SSH |

The last case is a deliberate limit. There is no second recovery service or external viewer.

## Verification

The implementation is accepted only with evidence for the actual durable and browser-visible
output:

1. A chat turn that calls a model and tool, updates a Surface, and appends an Event log entry has
   one `traceId` and correctly nested meaningful steps.
2. Provider failure, retry, failover, tool failure, and final failure appear at the correct step;
   a recovered error remains visible inside a completed root Trace.
3. Missing provider cost, token count, or reasoning stays absent rather than becoming zero or
   fabricated text.
4. Sentinel API keys, OAuth tokens, Authorization headers, session tokens, and sensitive nested
   values do not appear in JSONL, SQLite, REST responses, WebSocket frames, downloads, or
   `journald`.
5. A payload beyond 64 KiB is truncated with correct retained/original byte metadata.
6. Injected writer failure and queue saturation do not fail the observed chat/tool/Surface path and
   do produce a visible degraded state or gap.
7. Size and age fixtures prove Activity and Runtime rotation, oldest-complete-segment deletion,
   file permissions, and active-segment preservation.
8. Deleting, corrupting, truncating, or restoring the disposable index rebuilds safely and never
   dereferences a wrong JSONL record.
9. REST and WebSocket contract tests cover authentication, no-store responses, pagination,
   filtering, session revocation, cursor replay, and rotated-cursor gaps.
10. PWA tests prove the route is absent from navigation, direct authenticated access works,
    realtime starts unchecked, only the active view subscribes, state indicators are accessible,
    one COMPLETED dot renders, and mobile detail is usable.
11. An end-to-end smoke produces and follows real retained records, then confirms the same records
    remain available after a Gateway restart.
12. Operations documentation gives exact `journalctl` and Runtime-file commands for the hard-down
    case and states that the PWA cannot work while its Gateway is down.

## Delivery shape

One tracer-bullet issue delivers the typed contract, recording path, bounded persistence, read
APIs, dedicated realtime channel, and PWA console together. Splitting storage from the UI would
create horizontal issues that cannot demonstrate the debugging outcome independently.

No dependent recovery-viewer issue is created. Runtime JSONL and `journald` are the accepted
hard-down fallback.

## Alternatives rejected

- **Derive Activity from existing Event logs, sessions, usage, and console output:** correlation
  and timing would be incomplete and would conflate canonical and diagnostic records.
- **OpenTelemetry and an external collector:** unnecessary dependencies and operator concepts for
  one local Gateway.
- **Reuse the chat WebSocket:** a Runtime-log burst could interfere with the primary product path.
- **Record every internal function or token delta:** too noisy and expensive; Runtime logs already
  carry low-level evidence.
- **Permanent or temporary recovery viewer:** adds a second executable and authorization surface;
  retained files plus `journald` already answer hard-down failures over SSH.

## Research basis

- [Human observability in Hermes Agent](../../references/09-hermes-human-observability.md)
- [Operator log and trace interfaces](../../references/10-operator-log-trace-interfaces.md)
- [ADR-0011: disposable hybrid index](../../adr/0011-disposable-hybrid-index.md)
- [Security and trust model](../../SECURITY.md)
