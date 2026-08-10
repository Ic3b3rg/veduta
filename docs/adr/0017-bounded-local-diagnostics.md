# Local diagnostic traces are bounded, redacted, and non-canonical

Veduta needs to answer a narrow operational question: when something is slow, stuck, or failed,
which meaningful step caused it? The existing records cannot answer that reliably on their own.
A Space's Event log is canonical provenance used by the Agent, sessions preserve conversation
state, the security audit records privileged effects, and `journald` contains process output.
Reconstructing one operation by joining those records after the fact would produce incomplete
timing, fragile correlation, and pressure to pollute the Event log with implementation detail.

The Gateway therefore owns a dedicated **Trace** recorder. At an operation boundary it generates a
server-controlled `traceId`, propagates it through the AgentRunner wrapper and other meaningful
work, and appends redacted structured events for model attempts, tool calls, approvals, Surface
mutations, Event log appends, external calls, retries, failover, and completion. Token deltas and
ordinary internal function calls are not Trace events. Provider-emitted reasoning is optional data
on a model step, never fabricated and never treated as proof that an effect occurred.

Trace JSONL segments are the retained diagnostic source. A separate disposable SQLite index makes
their metadata searchable and is always validated by dereferencing the original JSONL record,
following the pattern of [ADR-0011](0011-disposable-hybrid-index.md). Neither is canonical product
state. Trace recording is fail-open: failure, saturation, or corruption may produce an explicit
gap but must never fail the operation being observed. The Event log and security audit keep their
existing fail-closed guarantees where required.

The Gateway also writes one installation-wide structured **Runtime log** to bounded rotating JSONL
segments and to `journald`. Runtime records use the same `traceId` when a Trace context exists, but
they remain separate: a Trace explains the meaningful path; the Runtime log supplies low-level
diagnostic detail. Both are collected continuously. A PWA control only enables realtime delivery;
it never turns persistence on or off.

All durable diagnostic values pass through the process-wide secret redactor before entering a
queue, file, index, WebSocket, or export. Authentication material, provider HTTP envelopes, the
system prompt, and the complete model context are never stored. Tool details and
provider-emitted reasoning are bounded and visibly truncated. The authenticated PWA may dereference
session content instead of duplicating full transcripts into Trace files.

The hidden `/app/trace` route is a read-only operator console with Activity and Runtime logs views.
Its REST APIs use the normal Bearer session, its dedicated WebSocket uses the existing origin plus
first-message session authentication pattern, and all responses are non-cacheable. The route's
absence from ordinary navigation is product restraint, not a security control.

No out-of-process recovery viewer or always-on diagnostic sidecar is introduced. When the Gateway
is unavailable, retained Runtime logs and `journald` are the sufficient SSH recovery path; after a
restart the same retained data is visible again in the PWA. This knowingly leaves hard startup
failures outside the PWA while avoiding a second service and authentication surface whose only job
would be diagnosing the first.

The alternatives rejected are deriving Activity from Event logs, sessions, usage, and console
text; adopting OpenTelemetry and an external collector for a single local Gateway; reusing the
chat WebSocket, where a log burst could interfere with answer streaming; and a permanent recovery
sidecar. Research supporting the human-facing design is recorded in
[Hermes human observability](../references/09-hermes-human-observability.md) and
[operator log and trace interfaces](../references/10-operator-log-trace-interfaces.md).

Status: accepted
