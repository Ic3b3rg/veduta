# Internal Trace Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the hidden, authenticated `/app/trace` console that identifies the meaningful step
where a Veduta operation is running, completed, or failed, with retained Activity and Runtime logs.

**Architecture:** The Gateway creates Gateway-owned correlation state with `AsyncLocalStorage`,
records bounded redacted Trace events to segmented JSONL, and indexes only searchable metadata in
a disposable SQLite database. A separate structured Runtime logger writes rotating JSONL plus a
concise process stream for `journald`; authenticated REST serves retained data and a dedicated
first-message-authenticated WebSocket serves opt-in realtime records. The PWA validates every
record through `@veduta/protocol` and renders a read-only Activity inspector or terminal-like
Runtime view.

**Tech Stack:** TypeScript ESM, Node 22+ (`AsyncLocalStorage`, `node:sqlite`, `node:fs`), Fastify 5,
`@fastify/websocket`, Zod 3, React 19, Vitest 3, Playwright, pnpm 10.

## Global Constraints

- Deliver [issue 050](../../../issues/050-internal-trace-console.md) and preserve
  [ADR-0017](../../adr/0017-bounded-local-diagnostics.md): diagnostics are non-canonical and
  fail-open; Space Event logs and security audit guarantees do not change.
- Keep code, comments, tests, UI copy, commits, and documentation in English and use the canonical
  `Trace`, `Runtime log`, `Space`, `Surface`, `Event log`, and `Gateway` vocabulary from
  `CONTEXT.md`.
- Add no runtime dependency and no OpenTelemetry, collector, metrics system, query language,
  alerting, command execution, retry, restart, configuration, retention, clear, or delete control.
- Keep every daemon-to-PWA shape in `@veduta/protocol`; validate before persistence, API output,
  WebSocket output, and rendering. Unknown additive Trace families render visibly.
- Never import `pi-agent-core` outside `pi-agent-runner.ts` and never expose model chain of thought;
  only provider-emitted reasoning explicitly present on a provider result may be retained.
- Redact and deny sensitive fields before queueing. Never persist credentials, OAuth tokens,
  cookies, authorization headers, passkey/session/bootstrap material, raw provider envelopes,
  system prompts, complete model context, or deliberately suppressed child-process stderr.
- Bound summaries to 512 UTF-8 bytes and details to 65,536 UTF-8 bytes after redaction. Mark detail
  truncation with the retained and pre-truncation byte sizes.
- Create diagnostic directories with mode `0700` and files with mode `0600`.
- Activity uses 5 MiB segments and retains at most 30 days or 200 MiB. Runtime uses at most ten
  5 MiB segments, 50 MiB, and seven days. Never truncate the active segment in place.
- Use a recorder queue capacity of 2,048 events, at most 256 per-Trace pending gap counters, and a
  WebSocket client queue of at most 256 frames or 1 MiB. Every loss boundary becomes a visible gap.
- REST defaults to 100 Activity summaries and caps pages at 200. A Runtime segment response is at
  most one retained 5 MiB segment. All diagnostic responses set `Cache-Control: no-store`.
- The hidden route is absent from ordinary navigation and uses the existing passkey session. The
  `Real-time logs` checkbox starts unchecked and is the only action that opens `/ws/trace`.
- Do not put diagnostic records in the service-worker cache, `localStorage`, or IndexedDB. Copy and
  download operate only on already-redacted records currently loaded in memory.
- Preserve unrelated working-tree changes. Execute this plan in an isolated worktree created with
  `superpowers:using-git-worktrees`.

---

## Target File Structure

### Shared protocol

- Create `packages/protocol/src/trace.ts`: Trace, Runtime log, pagination, segment, gap, and
  WebSocket schemas/types.
- Create `packages/protocol/src/trace.test.ts`: cross-runtime schema and byte-bound tests.
- Modify `packages/protocol/src/index.ts`: export the complete diagnostic contract.

### Gateway diagnostics

- Create `packages/daemon/src/diagnostic-sanitize.ts`: field denial, structural redaction, UTF-8
  bounding, and explicit truncation.
- Create `packages/daemon/src/diagnostic-cursor.ts`: versioned opaque cursor encode/decode.
- Create `packages/daemon/src/segmented-jsonl.ts`: generic append, rotation, retention, inventory,
  source dereference, and partial-line gaps.
- Create `packages/daemon/src/diagnostic-live.ts`: process-local Activity/Runtime publish-subscribe
  seam; it never blocks persistence.
- Create `packages/daemon/src/runtime-log.ts`: structured Runtime logger, rotating reader, emergency
  sink, active process logger, and fatal monitoring.
- Create `packages/daemon/src/trace-index.ts`: disposable SQLite FTS/filter index and reconciliation.
- Create `packages/daemon/src/trace-store.ts`: Activity JSONL plus validated index dereference.
- Create `packages/daemon/src/trace-context.ts`: `AsyncLocalStorage` correlation state.
- Create `packages/daemon/src/trace-recorder.ts`: root/step lifecycle, annotation, bounded queue,
  fail-open drain, and explicit gaps.
- Create `packages/daemon/src/diagnostics.ts`: constructs and closes the five diagnostic modules as
  one `Diagnostics` dependency.
- Create `packages/daemon/src/trace-reader.ts`: retained search/detail/segment/replay facade.
- Create `packages/daemon/src/trace-routes.ts`: authenticated no-store REST registration.
- Create `packages/daemon/src/trace-socket.ts`: dedicated authenticated realtime hub.
- Create a colocated `*.test.ts` for every module above.

### Existing Gateway seams

- Modify `packages/daemon/src/server.ts`: construct diagnostics, register REST/WS, pass the recorder
  into central seams, expose diagnostics to tests, and close it last after observed work stops.
- Modify `packages/daemon/src/index.ts`: fatal monitoring and safe structured process lifecycle
  logs while keeping Local VPS setup output outside diagnostic capture.
- Modify `packages/daemon/src/model-routing.ts`, `pi-agent-runner.ts`, and `chat-loop.ts`: model,
  tool, and chat lifecycle instrumentation.
- Modify `packages/daemon/src/spaces-engine.ts`, `store.ts`, and their tests: committed Event log
  observer used by instrumentation; reuse the existing committed Surface observer.
- Modify `packages/daemon/src/scheduler.ts`, `worker.ts`, `event-ingestion.ts`,
  `notification-center.ts`, `approval-surface.ts`, `trust-layer.ts`, and `update-manager.ts`: durable
  background roots and meaningful delivery/approval/update steps.
- Modify the non-CLI operational `console.*` call sites listed in Task 7 to use the structured
  Runtime logger. CLI output remains an injected command-line interface, not a Runtime record.

### PWA

- Create `packages/pwa/src/trace-api.ts`: validated REST and `/ws/trace` client.
- Modify `packages/pwa/src/api.ts`: export the existing authenticated `getJson` seam.
- Create `packages/pwa/src/trace-console-state.ts`: pure paging, connection, following, unseen, and
  filter transitions.
- Create `packages/pwa/src/trace-export.ts`: protocol-validated copy/download serialization of
  currently loaded in-memory records.
- Create `packages/pwa/src/trace-status.tsx`: the single accessible RUNNING/COMPLETED/ERROR marker.
- Create `packages/pwa/src/trace-activity.tsx`: search/filter toolbar, volume strip, dense rows, and
  selected-Trace inspector.
- Create `packages/pwa/src/trace-runtime.tsx`: retained/live terminal rows, segment loading,
  pause/follow behavior, copy, and download.
- Create `packages/pwa/src/trace-console.tsx` and `trace-console.css`: hidden full-page shell and
  shared realtime control.
- Create colocated tests for each pure module/component.
- Modify `packages/pwa/src/app.tsx` and `app.test.tsx`: direct route after the existing auth and
  onboarding gates, with no Home chat socket on that route and no navigation link.

### End-to-end and operations

- Modify `packages/daemon/src/security-hardening.test.ts`: one sentinel sweep across every
  diagnostic sink.
- Modify `packages/e2e/tests/local-vps.spec.ts`: authenticated trace, error localization, and
  restart-retention smoke.
- Create `docs/diagnostics.md`: normal PWA use and exact hard-down SSH commands.
- Modify `deploy/README.md` and `deploy/local-vps.md`: link the diagnostics runbook and remove advice
  that exposes a bootstrap code through production `journald`.

---

### Task 1: Define the diagnostic wire contract

**Files:**

- Create: `packages/protocol/src/trace.ts`
- Create: `packages/protocol/src/trace.test.ts`
- Modify: `packages/protocol/src/index.ts`

**Interfaces:**

- Produces: `TraceEvent`, `TraceSummary`, `TraceSearchQuery`, `TraceDetailQuery`, `TraceEventsPage`,
  `TraceDetailPage`, `RuntimeLogRecord`, `RuntimeLogSegment`, `RuntimeLogSegmentsResponse`,
  `RuntimeLogSegmentResponse`, `DiagnosticGap`, `DiagnosticBackendState`,
  `DiagnosticView`, `TraceSocketClientMessage`, and `TraceSocketServerMessage`, plus matching
  `*Schema` exports.
- `TraceEvent.details` is a discriminated known-family union plus an unknown-family object; known
  families are `model`, `tool`, `surface`, `event-log`, `approval`, `delivery`, `lifecycle`, and
  `truncated`.

- [ ] **Step 1: Write failing protocol tests**

```ts
import {
  RuntimeLogRecordSchema,
  TraceEventSchema,
  TraceEventsPageSchema,
  TraceSocketClientMessageSchema,
} from './trace.ts'

const base = {
  schemaVersion: 1,
  eventId: '11111111-1111-4111-8111-111111111111',
  traceId: '22222222-2222-4222-8222-222222222222',
  stepId: '33333333-3333-4333-8333-333333333333',
  at: '2026-08-10T12:00:00.000Z',
  kind: 'trace.started',
  operationKind: 'chat',
  component: 'chat-loop',
  summary: 'Chat turn',
}

it('accepts known and additive unknown event families without accepting malformed known data', () => {
  expect(
    TraceEventSchema.parse({
      ...base,
      details: {
        family: 'model',
        attempt: 0,
        provider: 'anthropic',
        modelId: 'claude-sonnet-5',
        tier: 'reasoning',
      },
    }),
  ).toBeDefined()
  expect(
    TraceEventSchema.parse({
      ...base,
      kind: 'step.new-kind',
      details: { family: 'future-family', safe: true },
    }),
  ).toBeDefined()
  expect(() =>
    TraceEventSchema.parse({ ...base, details: { family: 'model', attempt: -1 } }),
  ).toThrow()
})

it('rejects a summary over 512 UTF-8 bytes and details over 64 KiB', () => {
  expect(() => TraceEventSchema.parse({ ...base, summary: '€'.repeat(171) })).toThrow()
  expect(() =>
    TraceEventSchema.parse({
      ...base,
      details: { family: 'future-family', text: 'x'.repeat(65_537) },
    }),
  ).toThrow()
})

it('keeps credentials out of socket URLs by putting the optional token only in hello', () => {
  expect(
    TraceSocketClientMessageSchema.parse({ type: 'hello', token: 'session', view: 'activity' }),
  ).toBeDefined()
})
```

- [ ] **Step 2: Run the protocol test and verify the missing-module failure**

Run: `pnpm --filter @veduta/protocol exec vitest run src/trace.test.ts`

Expected: FAIL because `src/trace.ts` does not exist.

- [ ] **Step 3: Add the schemas with browser-safe UTF-8 validation**

```ts
import { z } from 'zod'
import { JsonObjectSchema } from './json.ts'

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength
const BoundedString = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .refine((value) => utf8Bytes(value) <= maxBytes, `must be <= ${maxBytes} UTF-8 bytes`)
const BoundedJsonObjectSchema = JsonObjectSchema.refine(
  (value) => utf8Bytes(JSON.stringify(value)) <= 65_536,
  'serialized JSON must be <= 65536 UTF-8 bytes',
)

export const TraceStatusSchema = z.enum(['RUNNING', 'COMPLETED', 'ERROR'])
export const DiagnosticBackendStateSchema = z.enum(['READY', 'INDEXING', 'DEGRADED'])
export const DiagnosticGapSchema = z.object({
  reason: z.enum([
    'queue-saturated',
    'partial-line',
    'source-missing',
    'source-changed',
    'cursor-expired',
    'backpressure',
    'replay-truncated',
  ]),
  message: BoundedString(512),
  at: z.string().datetime().optional(),
  count: z.number().int().positive().optional(),
})

const ModelDetailsSchema = z.object({
  family: z.literal('model'),
  attempt: z.number().int().nonnegative(),
  provider: z.string().min(1).max(80),
  modelId: z.string().min(1).max(200),
  tier: z.enum(['triage', 'reasoning']),
  connectionId: z.string().min(1).optional(),
  costUsd: z.number().nonnegative().finite().optional(),
  tokensUsed: z.number().int().nonnegative().optional(),
  reasoning: z.string().optional(),
})
const ToolDetailsSchema = z.object({
  family: z.literal('tool'),
  toolCallId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  input: JsonObjectSchema.optional(),
  result: JsonObjectSchema.optional(),
  isError: z.boolean().optional(),
})
const SurfaceDetailsSchema = z.object({
  family: z.literal('surface'),
  change: z.enum([
    'created',
    'updated',
    'pinned',
    'un-pinned',
    'proposal-created',
    'proposal-accepted',
    'proposal-rejected',
  ]),
  surfaceId: z.string().min(1).max(200),
  cursor: z.number().int().nonnegative().optional(),
})
const EventLogDetailsSchema = z.object({
  family: z.literal('event-log'),
  eventType: z.string().min(1).max(200),
  eventId: z.string().min(1).max(200).optional(),
})
const ApprovalDetailsSchema = z.object({
  family: z.literal('approval'),
  approvalId: z.string().min(1).max(200),
  effectId: z.string().min(1).max(200).optional(),
  toolName: z.string().min(1).max(200).optional(),
  level: z.enum(['L0', 'L1', 'L2']).optional(),
  outcome: z.enum(['pending', 'approved', 'rejected', 'expired', 'failed']),
})
const DeliveryDetailsSchema = z.object({
  family: z.literal('delivery'),
  deliveryId: z.string().min(1).max(200),
  channel: z.string().min(1).max(80),
  endpointHash: z.string().min(1).max(128).optional(),
  outcome: z.enum(['queued', 'delivered', 'retrying', 'failed']),
})
const LifecycleDetailsSchema = z.object({
  family: z.literal('lifecycle'),
  phase: z.string().min(1).max(120),
  outcome: z.string().min(1).max(120).optional(),
  attributes: JsonObjectSchema.optional(),
})
const TruncatedDetailsSchema = z.object({
  family: z.literal('truncated'),
  originalFamily: z.string().min(1).max(120).optional(),
  preview: z.string(),
})
const KnownDetailsSchema = z.discriminatedUnion('family', [
  ModelDetailsSchema,
  ToolDetailsSchema,
  SurfaceDetailsSchema,
  EventLogDetailsSchema,
  ApprovalDetailsSchema,
  DeliveryDetailsSchema,
  LifecycleDetailsSchema,
  TruncatedDetailsSchema,
])
const knownFamilies = new Set([
  'model',
  'tool',
  'surface',
  'event-log',
  'approval',
  'delivery',
  'lifecycle',
  'truncated',
])
const UnknownDetailsSchema = JsonObjectSchema.refine(
  (value) => typeof value['family'] === 'string' && !knownFamilies.has(value['family']),
  'unknown details must carry a non-reserved family',
)
export const TraceDetailsSchema = z.union([KnownDetailsSchema, UnknownDetailsSchema])
const TraceTruncationSchema = z
  .object({
    retainedBytes: z.number().int().nonnegative().max(65_536),
    originalBytes: z.number().int().positive(),
  })
  .refine(({ retainedBytes, originalBytes }) => originalBytes > retainedBytes)
const OptionalScopeSchema = {
  spaceId: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  workerId: z.string().min(1).max(200).optional(),
  automationId: z.number().int().positive().optional(),
  externalId: z.string().min(1).max(200).optional(),
}

export const TraceEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string().uuid(),
    traceId: z.string().uuid(),
    parentTraceId: z.string().uuid().optional(),
    stepId: z.string().uuid(),
    parentStepId: z.string().uuid().optional(),
    at: z.string().datetime(),
    kind: BoundedString(80),
    operationKind: BoundedString(80),
    component: BoundedString(120),
    summary: BoundedString(512),
    ...OptionalScopeSchema,
    durationMs: z.number().finite().nonnegative().optional(),
    details: TraceDetailsSchema.optional(),
    truncation: TraceTruncationSchema.optional(),
  })
  .superRefine((event, ctx) => {
    if (event.details !== undefined && utf8Bytes(JSON.stringify(event.details)) > 65_536) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['details'],
        message: 'serialized details must be <= 65536 UTF-8 bytes',
      })
    }
  })

export const TraceSummarySchema = z.object({
  traceId: z.string().uuid(),
  parentTraceId: z.string().uuid().optional(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  status: TraceStatusSchema,
  operationKind: BoundedString(80),
  component: BoundedString(120),
  summary: BoundedString(512),
  durationMs: z.number().finite().nonnegative().optional(),
  ...OptionalScopeSchema,
})
export const TraceSearchQuerySchema = z.object({
  q: z.string().max(256).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  spaceId: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  component: z.string().min(1).max(120).optional(),
  status: TraceStatusSchema.optional(),
  traceId: z.string().uuid().optional(),
  cursor: z.string().max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export const TraceDetailQuerySchema = z.object({
  cursor: z.string().max(2_048).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
})
export const TraceEventsPageSchema = z.object({
  items: z.array(TraceSummarySchema).max(200),
  nextCursor: z.string().max(2_048).optional(),
  gaps: z.array(DiagnosticGapSchema),
  backendState: DiagnosticBackendStateSchema,
})
export const TraceDetailPageSchema = z.object({
  trace: TraceSummarySchema,
  events: z.array(TraceEventSchema).max(200),
  nextCursor: z.string().max(2_048).optional(),
  gaps: z.array(DiagnosticGapSchema),
  backendState: DiagnosticBackendStateSchema,
})

export const RuntimeLogRecordSchema = z.object({
  schemaVersion: z.literal(1),
  recordId: z.string().uuid(),
  at: z.string().datetime(),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
  component: BoundedString(120),
  message: BoundedString(512),
  traceId: z.string().uuid().optional(),
  details: BoundedJsonObjectSchema.optional(),
  truncation: TraceTruncationSchema.optional(),
})
export const RuntimeLogSegmentSchema = z.object({
  segmentId: z.string().regex(/^seg-[0-9]{16}$/),
  firstAt: z.string().datetime().optional(),
  lastAt: z.string().datetime().optional(),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(5 * 1024 * 1024),
  records: z.number().int().nonnegative(),
  sealed: z.boolean(),
})
export const RuntimeLogSegmentsResponseSchema = z.object({
  segments: z.array(RuntimeLogSegmentSchema).max(10),
  gaps: z.array(DiagnosticGapSchema),
  backendState: DiagnosticBackendStateSchema,
})
export const RuntimeLogSegmentResponseSchema = z.object({
  segment: RuntimeLogSegmentSchema,
  records: z.array(RuntimeLogRecordSchema),
  gaps: z.array(DiagnosticGapSchema),
  backendState: DiagnosticBackendStateSchema,
})

export const DiagnosticViewSchema = z.enum(['activity', 'runtime'])
export const TraceSocketClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    token: z.string().min(1).optional(),
    view: DiagnosticViewSchema,
    cursor: z.string().max(2_048).optional(),
  }),
  z.object({
    type: z.literal('subscribe'),
    view: DiagnosticViewSchema,
    cursor: z.string().max(2_048).optional(),
  }),
])
export const TraceSocketServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('activity'),
    cursor: z.string().max(2_048),
    record: TraceEventSchema,
  }),
  z.object({
    type: z.literal('runtime'),
    cursor: z.string().max(2_048),
    record: RuntimeLogRecordSchema,
  }),
  z.object({ type: z.literal('gap'), view: DiagnosticViewSchema, gap: DiagnosticGapSchema }),
  z.object({
    type: z.literal('state'),
    view: DiagnosticViewSchema,
    state: DiagnosticBackendStateSchema,
  }),
])

export type DiagnosticBackendState = z.infer<typeof DiagnosticBackendStateSchema>
export type DiagnosticGap = z.infer<typeof DiagnosticGapSchema>
export type DiagnosticView = z.infer<typeof DiagnosticViewSchema>
export type RuntimeLogRecord = z.infer<typeof RuntimeLogRecordSchema>
export type RuntimeLogSegment = z.infer<typeof RuntimeLogSegmentSchema>
export type RuntimeLogSegmentsResponse = z.infer<typeof RuntimeLogSegmentsResponseSchema>
export type RuntimeLogSegmentResponse = z.infer<typeof RuntimeLogSegmentResponseSchema>
export type TraceDetailPage = z.infer<typeof TraceDetailPageSchema>
export type TraceDetailQuery = z.infer<typeof TraceDetailQuerySchema>
export type TraceDetails = z.infer<typeof TraceDetailsSchema>
export type TraceEvent = z.infer<typeof TraceEventSchema>
export type TraceEventsPage = z.infer<typeof TraceEventsPageSchema>
export type TraceSearchQuery = z.infer<typeof TraceSearchQuerySchema>
export type TraceSocketClientMessage = z.infer<typeof TraceSocketClientMessageSchema>
export type TraceSocketServerMessage = z.infer<typeof TraceSocketServerMessageSchema>
export type TraceSummary = z.infer<typeof TraceSummarySchema>
```

- [ ] **Step 4: Export every diagnostic schema and inferred type**

```ts
export {
  DiagnosticBackendStateSchema,
  DiagnosticGapSchema,
  RuntimeLogRecordSchema,
  RuntimeLogSegmentSchema,
  RuntimeLogSegmentsResponseSchema,
  RuntimeLogSegmentResponseSchema,
  TraceDetailPageSchema,
  TraceDetailQuerySchema,
  TraceDetailsSchema,
  TraceEventSchema,
  TraceEventsPageSchema,
  TraceSearchQuerySchema,
  TraceSocketClientMessageSchema,
  TraceSocketServerMessageSchema,
  TraceSummarySchema,
  type DiagnosticBackendState,
  type DiagnosticGap,
  type RuntimeLogRecord,
  type RuntimeLogSegment,
  type RuntimeLogSegmentsResponse,
  type RuntimeLogSegmentResponse,
  type TraceDetailPage,
  type TraceDetailQuery,
  type TraceEvent,
  type TraceEventsPage,
  type TraceSearchQuery,
  type TraceDetails,
  type TraceSocketClientMessage,
  type TraceSocketServerMessage,
  type TraceSummary,
  DiagnosticViewSchema,
  type DiagnosticView,
} from './trace.ts'
```

- [ ] **Step 5: Run protocol tests and package typecheck**

Run: `pnpm --filter @veduta/protocol exec vitest run src/trace.test.ts && pnpm --filter @veduta/protocol typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the contract**

```bash
git add packages/protocol/src/trace.ts packages/protocol/src/trace.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add trace console contract (issue #50)"
```

### Task 2: Redact, deny, and bound diagnostic values

**Files:**

- Create: `packages/daemon/src/diagnostic-sanitize.ts`
- Create: `packages/daemon/src/diagnostic-sanitize.test.ts`
- Modify: `packages/daemon/src/redaction.ts:47-115`
- Modify: `packages/daemon/src/redaction.test.ts:5-135`

**Interfaces:**

- Consumes: `TraceDetails`, `TraceEvent['truncation']`, `SecretRedactor`.
- Produces:
  - `sanitizeDiagnosticSummary(value: unknown, redactor?: SecretRedactor): string`
  - `sanitizeDiagnosticObject(value: unknown, redactor?: SecretRedactor): { value?: JsonObject; truncation?: { retainedBytes: number; originalBytes: number } }`
  - `sanitizeDiagnosticDetails(value: unknown, redactor?: SecretRedactor): { details?: TraceDetails; truncation?: { retainedBytes: number; originalBytes: number } }`
  - `sanitizeDiagnosticError(error: unknown, redactor?: SecretRedactor): { name: string; message: string; stack?: string }`
  - `denyDiagnosticFields(value: unknown): unknown`

- [ ] **Step 1: Write failing sanitizer tests**

```ts
it('removes denied keys before measuring or returning nested values', () => {
  const secret = 'oauth-secret-abcdefghijklmnop'
  const redactor = new SecretRedactor()
  redactor.register(secret)
  const result = sanitizeDiagnosticDetails(
    {
      family: 'future-family',
      safe: 'ok',
      nested: {
        authorization: `Bearer ${secret}`,
        refreshToken: secret,
        cookie: secret,
      },
    },
    redactor,
  )
  const serialized = JSON.stringify(result)
  expect(serialized).toContain('ok')
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toMatch(/authorization|refreshToken|cookie/i)
})

it('replaces oversized details with an explicit redacted truncated-family preview', () => {
  const result = sanitizeDiagnosticDetails({
    family: 'tool',
    toolCallId: 'call-1',
    toolName: 'search_memory',
    input: { text: 'x'.repeat(80_000) },
  })
  expect(result.details?.family).toBe('truncated')
  expect(result.truncation?.originalBytes).toBeGreaterThan(65_536)
  expect(result.truncation?.retainedBytes).toBeLessThanOrEqual(65_536)
})
```

- [ ] **Step 2: Run the sanitizer test and verify it fails**

Run: `pnpm --filter @veduta/daemon exec vitest run src/diagnostic-sanitize.test.ts`

Expected: FAIL because the sanitizer exports do not exist.

- [ ] **Step 3: Add field denial and UTF-8-safe truncation**

```ts
const DENIED_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'apikey',
  'xapikey',
  'accesstoken',
  'refreshtoken',
  'sessiontoken',
  'pairingcode',
  'bootstrapcode',
  'onetimecode',
  'passkey',
  'credential',
  'credentialid',
  'clientsecret',
  'privatekey',
  'password',
  'vaultkey',
  'systemprompt',
  'completecontext',
])
export const SUMMARY_BYTES = 512
export const DETAIL_BYTES = 65_536

export function denyDiagnosticFields(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[cycle]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => denyDiagnosticFields(entry, seen))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !DENIED_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, '')))
      .map(([key, entry]) => [key, denyDiagnosticFields(entry, seen)]),
  )
}
```

Redact after denial, serialize the redacted value, and when it exceeds 65,536 bytes replace it with
`{ family: 'truncated', originalFamily, preview }`. Build `preview` with a UTF-8 byte loop so a
multibyte code point is never split. Compute both byte counts only from redacted serialization.
Clamp a blank summary to `Diagnostic event` and convert errors to redacted name/message/stack text.
Collapse `\r`, `\n`, and repeated horizontal whitespace in summaries before the UTF-8 bound so
every stored summary remains one line.
`sanitizeDiagnosticObject` applies the same order and returns a `{ preview }` object for oversized
Runtime detail. `sanitizeDiagnosticDetails` adds the required `family: 'truncated'` envelope and
parses the result through `TraceDetailsSchema`.

- [ ] **Step 4: Strengthen the shared redactor for diagnostic credential shapes**

Add built-in patterns for `sk-ant-oat`, JWT-like bearer values, and Google OAuth refresh tokens;
keep longest/specific patterns before generic ones. Add tests that no fragment remains.

```ts
const BUILT_IN_PATTERNS: RegExp[] = [
  /sk-ant-oat[A-Za-z0-9_-]{8,}/g,
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /Bearer\s+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /1\/\/[A-Za-z0-9._~+/-]{20,}/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /vdt_[A-Za-z0-9_-]{8,}/g,
  /AKIA[0-9A-Z]{12,}/g,
]

const OAUTH_TOKEN = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature1234'
const GOOGLE_REFRESH = '1//0abcdefghijklmnopqrstuvwxyz0123456789'
expect(redactor.redactText(`oauth=${OAUTH_TOKEN}`)).toBe('oauth=[redacted]')
expect(redactor.redactText(`bearer ${JWT}`)).not.toContain(JWT)
expect(redactor.redactText(`refresh=${GOOGLE_REFRESH}`)).not.toContain(GOOGLE_REFRESH)
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/diagnostic-sanitize.test.ts src/redaction.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the sanitizer**

```bash
git add packages/daemon/src/diagnostic-sanitize.ts packages/daemon/src/diagnostic-sanitize.test.ts packages/daemon/src/redaction.ts packages/daemon/src/redaction.test.ts
git commit -m "feat(daemon): sanitize diagnostic records (issue #50)"
```

### Task 3: Add bounded segmented JSONL and opaque cursors

**Files:**

- Create: `packages/daemon/src/diagnostic-cursor.ts`
- Create: `packages/daemon/src/diagnostic-cursor.test.ts`
- Create: `packages/daemon/src/segmented-jsonl.ts`
- Create: `packages/daemon/src/segmented-jsonl.test.ts`

**Interfaces:**

- Produces `DiagnosticCursor { v: 1; stream; segmentId; line; recordId }` and
  `StoredLineRef { stream; segmentId; line; offset; length; sha256; cursor }` with numeric byte
  positions and a validated opaque cursor.
- Produces `SegmentInventoryItem { segmentId; firstAt?; lastAt?; bytes; records; sealed }`,
  `StoredLineReadResult<T> = { ok: true; value; ref } | { ok: false; gap }`,
  `SegmentReadResult<T> { segment: SegmentInventoryItem; records: T[]; gaps: DiagnosticGap[] }`, and
  `ReplayResult<T> { items: Array<{ cursor; record }>; gaps; lastCursor? }`.
- Produces `encodeDiagnosticCursor(payload)` and `decodeDiagnosticCursor(cursor, expectedStream)`;
  cursors are versioned base64url JSON and never contain an absolute path.
- Produces `SegmentedJsonlStore<T>` with `append`, `listSegments`, `readSegment`, `readRef`,
  `scan`, `replayAfter`, `rotate`, `enforceRetention`, and `close`.
- `SegmentedJsonlOptions<T>` requires `schema`, `idOf(record)`, `atOf(record)`, an injected clock,
  exact byte/age/segment limits, and optional `onSegmentsRemoved(ids)`; all methods are synchronous
  because the recorder owns the asynchronous queue boundary. `enforceRetention()` returns the IDs
  it removed and invokes the observer only after all corresponding files are gone.

- [ ] **Step 1: Write failing rotation, retention, permission, and corruption tests**

Use a 220-byte test segment limit, a fake clock, and a temporary directory. Assert:

```ts
const store = new SegmentedJsonlStore({
  stream: 'activity',
  dir,
  schema: TraceEventSchema,
  now,
  idOf: (record) => record.eventId,
  atOf: (record) => record.at,
  policy: { segmentBytes: 220, maxBytes: 660, maxAgeMs: 1_000 },
})
const first = store.append(event('first'))
store.append(event('second'))
expect(store.listSegments().length).toBeGreaterThan(1)
expect(statSync(dir).mode & 0o777).toBe(0o700)
const firstFile = readdirSync(dir).find((name) => name.startsWith(first.segmentId))
expect(statSync(join(dir, firstFile!)).mode & 0o777).toBe(0o600)
expect(store.readRef(first).ok).toBe(true)
```

Append an invalid final fragment to a sealed fixture and assert one `partial-line` gap. Change a
referenced line and assert `source-changed`; delete it and assert `source-missing`. Advance the fake
clock and verify only complete oldest segments are removed while the active segment survives.

- [ ] **Step 2: Run both focused tests and verify missing exports**

Run: `pnpm --filter @veduta/daemon exec vitest run src/diagnostic-cursor.test.ts src/segmented-jsonl.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement safe cursor parsing**

```ts
const CursorPayloadSchema = z.object({
  v: z.literal(1),
  stream: z.enum(['activity', 'runtime']),
  segmentId: z.string().regex(/^seg-[0-9]{16}$/),
  line: z.number().int().positive(),
  recordId: z.string().uuid(),
})

export function encodeDiagnosticCursor(payload: Omit<DiagnosticCursor, 'v'>): string {
  return Buffer.from(JSON.stringify({ v: 1, ...payload }), 'utf8').toString('base64url')
}
```

Decode with a 2,048-character limit, Zod-parse, and require the expected stream before any
filesystem lookup.

- [ ] **Step 4: Implement the generic segmented store**

Name segments `seg-<16-digit-sequence>.jsonl` and the active file
`seg-<16-digit-sequence>-open.jsonl`. On boot, rename every stale `-open` file to a complete segment
without modifying its bytes, then open the next sequence. Rotate before an append would exceed the
limit. Write one schema-validated JSON line through an `0600` descriptor, return its byte position
and SHA-256, and publish no path outside this module.

Implement retention as a loop over complete oldest segments until age, total-byte, and optional
segment-count constraints all pass. `readSegment` snapshots file size, ignores only a final partial
line, validates every complete line, and returns explicit gaps for invalid records.

```ts
export interface SegmentedJsonlOptions<T> {
  stream: DiagnosticView
  dir: string
  schema: z.ZodType<T>
  idOf: (record: T) => string
  atOf: (record: T) => string
  now: () => Date
  policy: { segmentBytes: number; maxBytes: number; maxAgeMs: number; maxSegments?: number }
  onSegmentsRemoved?: (segmentIds: string[]) => void
}

export class SegmentedJsonlStore<T> {
  append(input: T): StoredLineRef {
    const record = this.options.schema.parse(input)
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8')
    if (this.activeBytes > 0 && this.activeBytes + bytes.byteLength > this.policy.segmentBytes) {
      this.rotate()
    }
    const offset = this.activeBytes
    writeSync(this.activeFd, bytes)
    this.activeBytes += bytes.byteLength
    const ref = {
      stream: this.options.stream,
      segmentId: this.activeSegmentId,
      line: ++this.activeLine,
      offset,
      length: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      cursor: encodeDiagnosticCursor({
        stream: this.options.stream,
        segmentId: this.activeSegmentId,
        line: this.activeLine,
        recordId: this.options.idOf(record),
      }),
    }
    const removed = this.enforceRetention()
    if (removed.length > 0) this.options.onSegmentsRemoved?.(removed)
    return ref
  }

  readRef(ref: StoredLineRef): StoredLineReadResult<T> {
    const path = this.segmentPaths.get(ref.segmentId)
    if (!path)
      return {
        ok: false,
        gap: {
          reason: 'source-missing',
          message: `Retained segment ${ref.segmentId} is unavailable`,
        },
      }
    const fd = openSync(path, 'r')
    const bytes = Buffer.alloc(ref.length)
    try {
      readSync(fd, bytes, 0, ref.length, ref.offset)
    } finally {
      closeSync(fd)
    }
    const actualHash = createHash('sha256').update(bytes).digest('hex')
    if (actualHash !== ref.sha256)
      return {
        ok: false,
        gap: { reason: 'source-changed', message: `Retained segment ${ref.segmentId} changed` },
      }
    try {
      const value = this.options.schema.parse(JSON.parse(bytes.toString('utf8').trimEnd()))
      return { ok: true, value, ref }
    } catch {
      return {
        ok: false,
        gap: {
          reason: 'source-changed',
          message: `Retained record in ${ref.segmentId} is invalid`,
        },
      }
    }
  }
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/diagnostic-cursor.test.ts src/segmented-jsonl.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit segmented persistence**

```bash
git add packages/daemon/src/diagnostic-cursor.ts packages/daemon/src/diagnostic-cursor.test.ts packages/daemon/src/segmented-jsonl.ts packages/daemon/src/segmented-jsonl.test.ts
git commit -m "feat(daemon): add bounded diagnostic segments (issue #50)"
```

### Task 4: Build the Runtime logger and live broker

**Files:**

- Create: `packages/daemon/src/diagnostic-live.ts`
- Create: `packages/daemon/src/diagnostic-live.test.ts`
- Create: `packages/daemon/src/runtime-log.ts`
- Create: `packages/daemon/src/runtime-log.test.ts`

**Interfaces:**

- Produces `DiagnosticLiveBroker.subscribe(view, listener)` and `publish({ view, cursor, record })`.
- `DiagnosticLiveItem` is the union of `{ view: 'activity'; cursor; record: TraceEvent }`,
  `{ view: 'runtime'; cursor; record: RuntimeLogRecord }`, and
  `{ view: DiagnosticView; state: DiagnosticBackendState }`; `DiagnosticLiveListener` is
  `(item: DiagnosticLiveItem) => void`.
- Produces `RuntimeLogger.debug/info/warn/error(component, message, details?)`,
  `listSegmentsResponse(): RuntimeLogSegmentsResponse`,
  `readSegmentResponse(id): RuntimeLogSegmentResponse | undefined`, `replayAfter`, `close()`,
  `createRuntimeLogger(options)`, `setActiveRuntimeLogger(logger): () => void`, `runtimeLog`, and
  `installFatalRuntimeLogging(processLike): () => void`.
- Produces `RuntimeRetentionPolicy { segmentBytes, maxBytes, maxAgeMs, maxSegments }` and
  `DEFAULT_RUNTIME_POLICY = { segmentBytes: 5_242_880, maxBytes: 52_428_800,
maxAgeMs: 604_800_000, maxSegments: 10 }`.
- The emergency sink is injected as `(line: string) => void` and never calls the Runtime logger.
- A Runtime file failure permanently marks that process instance `DEGRADED` and increments a
  `source-missing` gap returned by both Runtime retained-read methods; `journald` output continues.

- [ ] **Step 1: Write failing Runtime logger and broker tests**

```ts
it('redacts before file, journal, and live publication', () => {
  const journal: string[] = []
  const live: RuntimeLogRecord[] = []
  broker.subscribe('runtime', (item) => live.push(item.record as RuntimeLogRecord))
  redactor.register('registered-secret-abcdefghijklmnop')
  logger.error('provider', 'failed', { authorization: 'Bearer registered-secret-abcdefghijklmnop' })
  for (const text of [journal.join('\n'), JSON.stringify(live), readAllRuntimeFiles(dir)]) {
    expect(text).not.toContain('registered-secret')
    expect(text).not.toContain('authorization')
  }
})

it('uses the emergency sink once when the file append fails and still emits journal output', () => {
  failingStore.failNextAppend()
  logger.warn('trace-store', 'append failed')
  expect(emergency).toHaveBeenCalledTimes(1)
  expect(journal).toHaveLength(1)
})
```

Also test all four levels, optional `traceId`, ten-segment/50 MiB/seven-day policy via tiny limits,
broker listener isolation, and `uncaughtExceptionMonitor` logging without adding an
`uncaughtException` handler. Emit the monitor event once with origin `uncaughtException` and once
with origin `unhandledRejection`; both must be retained while `listenerCount('uncaughtException')`
stays unchanged.

- [ ] **Step 2: Run the tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/diagnostic-live.test.ts src/runtime-log.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the non-blocking broker**

```ts
export class DiagnosticLiveBroker {
  private listeners = new Map<'activity' | 'runtime', Set<DiagnosticLiveListener>>()
  subscribe(view: DiagnosticView, listener: DiagnosticLiveListener): () => void {
    const set = this.listeners.get(view) ?? new Set()
    set.add(listener)
    this.listeners.set(view, set)
    return () => set.delete(listener)
  }
  publish(item: DiagnosticLiveItem): void {
    for (const listener of this.listeners.get(item.view) ?? []) {
      try {
        listener(item)
      } catch {
        /* a browser observer cannot fail persistence */
      }
    }
  }
}
```

- [ ] **Step 4: Implement the Runtime logger**

Create a `SegmentedJsonlStore<RuntimeLogRecord>` under `<rootDir>/diagnostics/runtime`. Sanitize the
message and details before constructing a record, append it, publish the returned cursor, then emit
one concise JSON line to the injected journal sink. If append or publish fails, write one bounded
redacted message through the emergency sink and continue the caller.

The exported `runtimeLog` delegates to an active logger and defaults to an emergency-only logger.
`setActiveRuntimeLogger` returns a disposer that restores the previous logger only when it still
owns the active slot. Fatal monitoring listens to `uncaughtExceptionMonitor`, which observes the
exception without changing Node's termination behavior.

```ts
export interface RuntimeLoggerOptions {
  store: SegmentedJsonlStore<RuntimeLogRecord>
  live: DiagnosticLiveBroker
  redactor: SecretRedactor
  currentTraceId: () => string | undefined
  journalSink: (line: string) => void
  emergencySink: (line: string) => void
  now: () => Date
}

export class RuntimeLogger {
  private stateValue: DiagnosticBackendState = 'READY'
  private fileGapCount = 0

  debug(component: string, message: string, details?: unknown): void {
    this.write('DEBUG', component, message, details)
  }
  info(component: string, message: string, details?: unknown): void {
    this.write('INFO', component, message, details)
  }
  warn(component: string, message: string, details?: unknown): void {
    this.write('WARN', component, message, details)
  }
  error(component: string, message: string, details?: unknown): void {
    this.write('ERROR', component, message, details)
  }

  listSegmentsResponse(): RuntimeLogSegmentsResponse {
    return RuntimeLogSegmentsResponseSchema.parse({
      segments: this.options.store.listSegments(),
      gaps: this.retainedGaps(),
      backendState: this.stateValue,
    })
  }

  readSegmentResponse(id: string): RuntimeLogSegmentResponse | undefined {
    const read = this.options.store.readSegment(id)
    if (!read) return undefined
    return RuntimeLogSegmentResponseSchema.parse({
      segment: read.segment,
      records: read.records,
      gaps: [...this.retainedGaps(), ...read.gaps],
      backendState: this.stateValue,
    })
  }

  private write(
    level: RuntimeLogRecord['level'],
    component: string,
    message: string,
    details?: unknown,
  ): void {
    const safeDetails = sanitizeDiagnosticObject(details, this.options.redactor)
    const traceId = this.options.currentTraceId()
    const record = RuntimeLogRecordSchema.parse({
      schemaVersion: 1,
      recordId: randomUUID(),
      at: this.options.now().toISOString(),
      level,
      component: sanitizeDiagnosticSummary(component, this.options.redactor),
      message: sanitizeDiagnosticSummary(message, this.options.redactor),
      ...(traceId ? { traceId } : {}),
      ...(safeDetails.value ? { details: safeDetails.value } : {}),
      ...(safeDetails.truncation ? { truncation: safeDetails.truncation } : {}),
    })
    try {
      const ref = this.options.store.append(record)
      this.options.live.publish({ view: 'runtime', cursor: ref.cursor, record })
    } catch (error) {
      this.stateValue = 'DEGRADED'
      this.fileGapCount += 1
      this.options.live.publish({ view: 'runtime', state: 'DEGRADED' })
      this.emergency(error)
    }
    try {
      this.options.journalSink(JSON.stringify(record))
    } catch (error) {
      this.emergency(error)
    }
  }

  private emergency(error: unknown): void {
    try {
      this.options.emergencySink(this.options.redactor.redactError(error))
    } catch {
      /* fail open */
    }
  }

  private retainedGaps(): DiagnosticGap[] {
    return this.fileGapCount === 0
      ? []
      : [
          {
            reason: 'source-missing',
            message: 'Runtime records could not be retained by the file sink',
            count: this.fileGapCount,
          },
        ]
  }
}

export function createRuntimeLogger(
  options: Omit<RuntimeLoggerOptions, 'store'> & {
    rootDir: string
    limits?: Partial<RuntimeRetentionPolicy>
  },
): RuntimeLogger {
  return new RuntimeLogger({
    ...options,
    store: new SegmentedJsonlStore({
      stream: 'runtime',
      dir: join(options.rootDir, 'diagnostics', 'runtime'),
      schema: RuntimeLogRecordSchema,
      idOf: (record) => record.recordId,
      atOf: (record) => record.at,
      now: options.now,
      policy: { ...DEFAULT_RUNTIME_POLICY, ...options.limits },
    }),
  })
}

let activeRuntimeLogger: RuntimeLogger | undefined
export function setActiveRuntimeLogger(logger: RuntimeLogger): () => void {
  activeRuntimeLogger = logger
  return () => {
    if (activeRuntimeLogger === logger) activeRuntimeLogger = undefined
  }
}
const emergencyWrite = (
  level: RuntimeLogRecord['level'],
  component: string,
  message: string,
): void => {
  process.stderr.write(
    `${level} ${sanitizeDiagnosticSummary(component)} ${sanitizeDiagnosticSummary(message)}\n`,
  )
}
const dispatchRuntimeLog = (
  level: RuntimeLogRecord['level'],
  component: string,
  message: string,
  details?: unknown,
): void => {
  if (!activeRuntimeLogger) return emergencyWrite(level, component, message)
  activeRuntimeLogger[level.toLowerCase() as Lowercase<RuntimeLogRecord['level']>](
    component,
    message,
    details,
  )
}
export const runtimeLog = {
  debug: (component: string, message: string, details?: unknown) =>
    dispatchRuntimeLog('DEBUG', component, message, details),
  info: (component: string, message: string, details?: unknown) =>
    dispatchRuntimeLog('INFO', component, message, details),
  warn: (component: string, message: string, details?: unknown) =>
    dispatchRuntimeLog('WARN', component, message, details),
  error: (component: string, message: string, details?: unknown) =>
    dispatchRuntimeLog('ERROR', component, message, details),
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/diagnostic-live.test.ts src/runtime-log.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Runtime logging primitives**

```bash
git add packages/daemon/src/diagnostic-live.ts packages/daemon/src/diagnostic-live.test.ts packages/daemon/src/runtime-log.ts packages/daemon/src/runtime-log.test.ts
git commit -m "feat(daemon): add structured runtime logs (issue #50)"
```

### Task 5: Persist, index, search, and dereference Activity

**Files:**

- Create: `packages/daemon/src/trace-index.ts`
- Create: `packages/daemon/src/trace-index.test.ts`
- Create: `packages/daemon/src/trace-store.ts`
- Create: `packages/daemon/src/trace-store.test.ts`

**Interfaces:**

- Consumes `DiagnosticLiveBroker`; every `INDEXING`, `READY`, or `DEGRADED` transition is
  published to an opted-in Activity client.
- Produces `TraceIndex.index(ref, event)`, `search(query)`, `refsForTrace(traceId, cursor, limit)`,
  `pruneSegments(segmentIds)`, `reconcile(store)`, `state()`, `rebuild(store)`, and `close()`.
- Produces `TraceStore.append(event)`, `search(query)`,
  `readTrace(traceId, query): TraceDetailPage | undefined`, `replayAfter`, `reconcile`,
  `state`, `markDegraded(reason)`, `flush`, and `close`, plus `createTraceStore(options)`.
- Produces `ActivityRetentionPolicy { segmentBytes, maxBytes, maxAgeMs }` and
  `DEFAULT_ACTIVITY_POLICY = { segmentBytes: 5_242_880, maxBytes: 209_715_200,
maxAgeMs: 2_592_000_000 }`.
- Search returns source references, not trusted copied detail. `TraceStore` dereferences and
  re-validates every event before forming protocol responses.

- [ ] **Step 1: Write failing index/store tests**

Cover newest-first pagination, plain-term search, every explicit filter, RUNNING/COMPLETED/ERROR
derivation, a failed model step inside a completed root, deletion/corruption/schema mismatch,
changed-prefix detection, rotated-orphan pruning, source dereference, and `0600` permissions for
the index plus any WAL/SHM files.
Search for a failed step's safe summary and assert it returns the containing root Trace, not only
roots whose own summary matches.

```ts
const started = await appendRoot(store, { summary: 'Import calendar', spaceId: 'spc-life' })
await appendTerminal(store, started, 'trace.completed')
expect(store.search({ q: 'calendar', status: 'COMPLETED', limit: 100 }).items[0]?.traceId).toBe(
  started.traceId,
)

for (const suffix of ['', '-wal', '-shm']) rmSync(`${indexPath}${suffix}`, { force: true })
const rebuilt = new TraceStore(options)
expect(rebuilt.search({ traceId: started.traceId, limit: 100 }).items).toHaveLength(1)
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-index.test.ts src/trace-store.test.ts`

Expected: FAIL.

- [ ] **Step 3: Add the disposable SQLite schema**

```sql
create table metadata (key text primary key, value text not null);
create table segment_cursors (
  segment_id text primary key, indexed_bytes integer not null,
  indexed_lines integer not null, prefix_hash text not null
);
create table trace_events (
  event_id text primary key, trace_id text not null, at text not null,
  kind text not null, operation_kind text not null, component text not null,
  summary text not null, space_id text, session_id text,
  segment_id text not null, line integer not null, offset integer not null,
  length integer not null, line_hash text not null
);
create table trace_summaries (
  trace_id text primary key, started_at text not null, updated_at text not null,
  parent_trace_id text, root_event_id text not null, terminal_event_id text, status text not null,
  operation_kind text not null, component text not null, summary text not null,
  duration_ms real, space_id text, session_id text, worker_id text,
  automation_id integer, external_id text
);
create virtual table trace_event_fts using fts5(
  event_id unindexed, trace_id unindexed, text, tokenize='unicode61'
);
```

Set `schema_version=1`; mismatch deletes the database plus `-wal`/`-shm` and rebuilds. Tokenize
plain search on whitespace and quote every FTS term so operators such as `OR`, `*`, and `NEAR` are
ordinary text rather than a query language. Index every Trace event's redacted summary in
`trace_event_fts`; search selects distinct matching `trace_id` values and returns their root
summaries newest-first.

After opening and after every transaction that can create a WAL/SHM file, enforce `0600` on every
existing index file. The enclosing diagnostics directory is already `0700` from Task 3.

```ts
private enforcePermissions(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const path = `${this.path}${suffix}`
    if (existsSync(path)) chmodSync(path, 0o600)
  }
}
```

- [ ] **Step 4: Implement reconciliation and validated read paths**

Mirror `MemoryIndex`'s prefix-hash discipline: inventory both directions, append unindexed tails,
reindex shortened/changed segments, prune absent segments, and update a summary transactionally
with each indexed lifecycle event. Search rows contain only refs and metadata. Before returning a
summary, dereference its root and optional terminal refs; before returning detail, dereference each
event ref and check SHA-256 plus `TraceEventSchema`.

Wire Task 3's retention observer to `TraceIndex.pruneSegments` so a long-running Gateway does not
keep metadata for rotated source. Catch pruning failures, mark the backend DEGRADED, and continue
the already-completed retention and product operation.

```ts
export class TraceStore {
  markDegraded(reason: string): void {
    this.setState('DEGRADED')
    this.runtime.warn('trace-store', 'Activity diagnostics are degraded', { reason })
  }

  private setState(state: DiagnosticBackendState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    this.live.publish({ view: 'activity', state })
  }

  append(event: TraceEvent): StoredLineRef {
    const parsed = TraceEventSchema.parse(event)
    const ref = this.segments.append(parsed)
    try {
      this.index.index(ref, parsed)
    } catch (error) {
      this.setState('DEGRADED')
      this.runtime.warn(
        'trace-index',
        'Trace index append failed; retained source remains available',
        { error },
      )
    }
    return ref
  }

  reconcile(): void {
    try {
      this.setState('INDEXING')
      this.index.reconcile(this.segments)
      this.setState('READY')
    } catch (error) {
      this.setState('DEGRADED')
      this.runtime.warn('trace-index', 'Trace index reconciliation failed', { error })
    }
  }

  onSegmentsRemoved(segmentIds: string[]): void {
    try {
      this.index.pruneSegments(segmentIds)
    } catch (error) {
      this.setState('DEGRADED')
      this.runtime.warn('trace-index', 'Rotated Trace metadata could not be pruned', { error })
    }
  }

  readTrace(traceId: string, query: TraceDetailQuery): TraceDetailPage | undefined {
    const result = this.index.refsForTrace(traceId, query.cursor, query.limit)
    if (!result) return undefined
    const reads = result.refs.map((ref) => this.segments.readRef(ref))
    const events = reads.flatMap((read) => (read.ok ? [TraceEventSchema.parse(read.value)] : []))
    const gaps = reads.flatMap((read) => (read.ok ? [] : [read.gap]))
    return TraceDetailPageSchema.parse({
      trace: result.summary,
      events,
      nextCursor: result.nextCursor,
      gaps,
      backendState: this.stateValue,
    })
  }
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-index.test.ts src/trace-store.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit Activity persistence**

```bash
git add packages/daemon/src/trace-index.ts packages/daemon/src/trace-index.test.ts packages/daemon/src/trace-store.ts packages/daemon/src/trace-store.test.ts
git commit -m "feat(daemon): persist searchable traces (issue #50)"
```

### Task 6: Add correlation context and the fail-open recorder

**Files:**

- Create: `packages/daemon/src/trace-context.ts`
- Create: `packages/daemon/src/trace-context.test.ts`
- Create: `packages/daemon/src/trace-recorder.ts`
- Create: `packages/daemon/src/trace-recorder.test.ts`
- Create: `packages/daemon/src/diagnostics.ts`
- Create: `packages/daemon/src/diagnostics.test.ts`

**Interfaces:**

- Produces `TraceContext.current()`, `run(scope, fn)`, and `captureParentTraceId()`.
- Produces `TraceRecorder.runRoot`, `runStep`, `annotateCurrent`, `recordInstantStep`, `flush`, and
  `close`, plus `captureParentTraceId(): string | undefined`. Root/step wrappers return the
  observed result and rethrow the observed error unchanged.
- Produces `Diagnostics { runtime, traces, traceStore, live, close }` and
  `createDiagnostics({ rootDir, now?, limits? })`.
- `TraceOperationInput` is `{ operationKind, component, summary, parentTraceId?, spaceId?,
sessionId?, workerId?, automationId?, externalId?, details? }`; `runRoot<T>` and `runStep<T>`
  accept that input plus `() => T | Promise<T>` and return `Promise<T>`.
- `TraceAnnotationInput` is `{ summary?: string; details?: unknown }`;
  `annotateCurrent(input): void` writes `step.updated`, and
  `recordInstantStep(input: TraceOperationInput): void` writes one start/completion pair only when
  a current Trace exists.
- `DiagnosticLimits` is `{ activity?: Partial<ActivityRetentionPolicy>; runtime?:
Partial<RuntimeRetentionPolicy>; recorderQueue?: number; pendingGapTraces?: number }`.
- `CreateDiagnosticsOptions` is `{ rootDir: string; now?: () => Date; limits?:
DiagnosticLimits; journalSink?: (line: string) => void; emergencySink?:
(line: string) => void }`.

- [ ] **Step 1: Write failing context and recorder tests**

```ts
await recorder.runRoot(
  { operationKind: 'chat', component: 'chat-loop', summary: 'Chat turn' },
  async () =>
    recorder.runStep(
      {
        operationKind: 'tool',
        component: 'agent-runner',
        summary: 'Run search_memory',
        details: { family: 'tool', toolCallId: 'c1', toolName: 'search_memory' },
      },
      async () => {
        expect(context.current()?.parentStepId).toBeDefined()
      },
    ),
)
await recorder.flush()
expect(events.map((event) => event.kind)).toEqual([
  'trace.started',
  'step.started',
  'step.completed',
  'trace.completed',
])
expect(new Set(events.map((event) => event.traceId)).size).toBe(1)
```

Also assert observed errors retain identity, recorder/store failures do not change observed
results, queue saturation emits a counted `queue-saturated` gap, 257 distinct saturated Traces use
the bounded overflow gap, annotations reuse the current step ID, and detached roots preserve only
`parentTraceId` rather than an in-memory parent step.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-context.test.ts src/trace-recorder.test.ts src/diagnostics.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `AsyncLocalStorage` scope**

```ts
export interface ActiveTraceScope {
  traceId: string
  stepId: string
  operationKind: string
  component: string
  summary: string
  parentStepId?: string
  parentTraceId?: string
  spaceId?: string
  sessionId?: string
  workerId?: string
  automationId?: number
}

export class TraceContext {
  private readonly storage = new AsyncLocalStorage<ActiveTraceScope>()
  current(): ActiveTraceScope | undefined {
    return this.storage.getStore()
  }
  run<T>(scope: ActiveTraceScope, fn: () => T): T {
    return this.storage.run(scope, fn)
  }
  captureParentTraceId(): string | undefined {
    return this.current()?.traceId
  }
}
```

- [ ] **Step 4: Implement recorder lifecycle and queue discipline**

`runRoot` creates its UUIDs, enqueues `trace.started`, executes inside the context, then enqueues
`trace.completed` or `trace.failed` with measured duration. `runStep` does the same with
`step.started` and one terminal event. `recordInstantStep` enqueues a start and completion under the
current scope and is a no-op without one. `annotateCurrent` emits `step.updated` with the same
`stepId`.

Sanitize before queue insertion. Drain in a microtask, preserve FIFO order, and catch every
store/broker failure through `runtime.warn`. On saturation, count by `traceId`; when capacity
returns, enqueue a gap before that Trace's next record. Cap the map at 256 and use one recorder-root
overflow gap for additional Trace IDs.

```ts
export class TraceRecorder {
  private readonly queue: TraceEvent[] = []
  private readonly pendingGaps = new Map<string, number>()
  private readonly overflowTraceId = randomUUID()
  private readonly overflowStepId = randomUUID()
  private overflowGapCount = 0
  private drainScheduled = false

  async runRoot<T>(input: TraceOperationInput, work: () => T | Promise<T>): Promise<T> {
    const started = this.tryMakeStarted('trace.started', input, {
      traceId: randomUUID(),
      stepId: randomUUID(),
    })
    if (!started) return await work()
    this.enqueue(started)
    return this.context.run(scopeFrom(started), async () => {
      const began = performance.now()
      try {
        const result = await work()
        this.enqueueTerminal(started, 'trace.completed', performance.now() - began)
        return result
      } catch (error) {
        this.enqueueTerminal(
          started,
          'trace.failed',
          performance.now() - began,
          sanitizeDiagnosticError(error),
        )
        throw error
      }
    })
  }

  async runStep<T>(input: TraceOperationInput, work: () => T | Promise<T>): Promise<T> {
    const parent = this.context.current()
    if (!parent) return await work()
    const started = this.tryMakeStarted('step.started', input, {
      traceId: parent.traceId,
      stepId: randomUUID(),
      parentStepId: parent.stepId,
    })
    if (!started) return await work()
    this.enqueue(started)
    return this.context.run(scopeFrom(started), async () => {
      const began = performance.now()
      try {
        const result = await work()
        this.enqueueTerminal(started, 'step.completed', performance.now() - began)
        return result
      } catch (error) {
        this.enqueueTerminal(
          started,
          'step.failed',
          performance.now() - began,
          sanitizeDiagnosticError(error),
        )
        throw error
      }
    })
  }

  captureParentTraceId(): string | undefined {
    return this.context.captureParentTraceId()
  }

  annotateCurrent(input: TraceAnnotationInput): void {
    const scope = this.context.current()
    if (!scope) return
    this.tryEnqueue(() =>
      TraceEventSchema.parse({
        schemaVersion: 1,
        eventId: randomUUID(),
        traceId: scope.traceId,
        stepId: scope.stepId,
        parentStepId: scope.parentStepId,
        at: this.now().toISOString(),
        kind: 'step.updated',
        operationKind: scope.operationKind,
        component: scope.component,
        summary: input.summary ?? scope.summary,
        ...(input.details === undefined ? {} : { details: input.details }),
      }),
    )
  }

  recordInstantStep(input: TraceOperationInput): void {
    const parent = this.context.current()
    if (!parent) return
    const started = this.tryMakeStarted('step.started', input, {
      traceId: parent.traceId,
      stepId: randomUUID(),
      parentStepId: parent.stepId,
    })
    if (!started) return
    this.enqueue(started)
    this.enqueueTerminal(started, 'step.completed', 0)
  }

  private tryMakeStarted(
    kind: 'trace.started' | 'step.started',
    input: TraceOperationInput,
    ids: { traceId: string; stepId: string; parentStepId?: string },
  ): TraceEvent | undefined {
    try {
      return this.makeStarted(kind, input, ids)
    } catch (error) {
      this.runtime.warn('trace-recorder', 'Trace start could not be created', { error })
      return undefined
    }
  }

  private enqueueTerminal(
    started: TraceEvent,
    kind: 'trace.completed' | 'trace.failed' | 'step.completed' | 'step.failed',
    durationMs: number,
    error?: ReturnType<typeof sanitizeDiagnosticError>,
  ): void {
    this.tryEnqueue(() => this.makeTerminal(started, kind, durationMs, error))
  }

  private tryEnqueue(create: () => TraceEvent): void {
    try {
      this.enqueue(create())
    } catch (error) {
      this.runtime.warn('trace-recorder', 'Trace event could not be created', { error })
    }
  }

  private makeStarted(
    kind: 'trace.started' | 'step.started',
    input: TraceOperationInput,
    ids: { traceId: string; stepId: string; parentStepId?: string },
  ): TraceEvent {
    const safe = sanitizeDiagnosticDetails(input.details)
    const candidate: Record<string, unknown> = {
      schemaVersion: 1,
      eventId: randomUUID(),
      ...ids,
      at: this.now().toISOString(),
      kind,
      operationKind: input.operationKind,
      component: input.component,
      summary: input.summary,
      ...safe,
    }
    for (const key of [
      'parentTraceId',
      'spaceId',
      'sessionId',
      'workerId',
      'automationId',
      'externalId',
    ] as const)
      if (input[key] !== undefined) candidate[key] = input[key]
    return TraceEventSchema.parse(candidate)
  }

  private makeTerminal(
    started: TraceEvent,
    kind: 'trace.completed' | 'trace.failed' | 'step.completed' | 'step.failed',
    durationMs: number,
    error?: ReturnType<typeof sanitizeDiagnosticError>,
  ): TraceEvent {
    return TraceEventSchema.parse({
      ...started,
      eventId: randomUUID(),
      at: this.now().toISOString(),
      kind,
      durationMs,
      ...(error
        ? {
            details: { family: 'lifecycle', phase: kind, outcome: 'failed', attributes: { error } },
          }
        : { details: undefined }),
      truncation: undefined,
    })
  }

  private sanitize(event: TraceEvent): TraceEvent {
    const safe = sanitizeDiagnosticDetails(event.details)
    return TraceEventSchema.parse({
      ...event,
      summary: sanitizeDiagnosticSummary(event.summary),
      details: undefined,
      truncation: undefined,
      ...safe,
    })
  }

  private enqueue(event: TraceEvent): void {
    let safe: TraceEvent
    try {
      safe = this.sanitize(event)
    } catch (error) {
      this.runtime.warn('trace-recorder', 'Trace event could not be sanitized', { error })
      return
    }
    const lost = this.pendingGaps.get(safe.traceId)
    if (lost !== undefined && this.queue.length <= this.capacity - 2) {
      this.queue.push(this.makeGap(safe, lost))
      this.pendingGaps.delete(safe.traceId)
    }
    if (this.overflowGapCount > 0 && this.queue.length <= this.capacity - 2) {
      this.queue.push(this.makeOverflowGap(this.overflowGapCount))
      this.overflowGapCount = 0
    }
    if (this.queue.length >= this.capacity) return this.countGap(safe.traceId)
    this.queue.push(safe)
    if (!this.drainScheduled) {
      this.drainScheduled = true
      queueMicrotask(() => this.drain())
    }
  }

  private countGap(traceId: string): void {
    this.store.markDegraded('queue-saturated')
    const current = this.pendingGaps.get(traceId)
    if (current !== undefined) this.pendingGaps.set(traceId, current + 1)
    else if (this.pendingGaps.size < this.pendingGapLimit) this.pendingGaps.set(traceId, 1)
    else this.overflowGapCount += 1
  }

  private makeGap(source: TraceEvent, count: number): TraceEvent {
    return TraceEventSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      traceId: source.traceId,
      stepId: source.stepId,
      parentStepId: source.parentStepId,
      at: this.now().toISOString(),
      kind: 'diagnostic.gap',
      operationKind: 'diagnostic',
      component: 'trace-recorder',
      summary: `${count} Trace records were dropped`,
      details: {
        family: 'lifecycle',
        phase: 'diagnostic-gap',
        outcome: 'dropped',
        attributes: { reason: 'queue-saturated', count },
      },
    })
  }

  private makeOverflowGap(count: number): TraceEvent {
    return TraceEventSchema.parse({
      schemaVersion: 1,
      eventId: randomUUID(),
      traceId: this.overflowTraceId,
      stepId: this.overflowStepId,
      at: this.now().toISOString(),
      kind: 'diagnostic.gap',
      operationKind: 'diagnostic',
      component: 'trace-recorder',
      summary: `${count} Trace records were dropped`,
      details: {
        family: 'lifecycle',
        phase: 'diagnostic-gap',
        outcome: 'dropped',
        attributes: { reason: 'queue-saturated-overflow', count },
      },
    })
  }

  private drain(): void {
    this.drainScheduled = false
    for (let event = this.queue.shift(); event; event = this.queue.shift()) {
      try {
        const ref = this.store.append(event)
        this.live.publish({ view: 'activity', cursor: ref.cursor, record: event })
      } catch (error) {
        this.store.markDegraded('append-failed')
        this.countGap(event.traceId)
        this.runtime.warn('trace-recorder', 'Trace record could not be retained', { error })
      }
    }
  }
}

function scopeFrom(event: TraceEvent): ActiveTraceScope {
  const scope: ActiveTraceScope = {
    traceId: event.traceId,
    stepId: event.stepId,
    operationKind: event.operationKind,
    component: event.component,
    summary: event.summary,
  }
  for (const key of [
    'parentStepId',
    'parentTraceId',
    'spaceId',
    'sessionId',
    'workerId',
    'automationId',
  ] as const)
    if (event[key] !== undefined) Object.assign(scope, { [key]: event[key] })
  return scope
}
```

- [ ] **Step 5: Compose and close diagnostics in dependency order**

Create context, live broker, Runtime logger, Trace store, recorder, then reader. `close()` first
flushes the recorder, then closes the Trace index/store and Runtime store. A close error is written
through the Runtime emergency sink and does not prevent the remaining closes.

```ts
export interface Diagnostics {
  runtime: RuntimeLogger
  traces: TraceRecorder
  traceStore: TraceStore
  live: DiagnosticLiveBroker
  close(): Promise<void>
}

export function createDiagnostics(options: CreateDiagnosticsOptions): Diagnostics {
  const context = new TraceContext()
  const live = new DiagnosticLiveBroker()
  const now = options.now ?? (() => new Date())
  const runtime = createRuntimeLogger({
    ...options,
    now,
    live,
    limits: options.limits?.runtime,
    currentTraceId: () => context.current()?.traceId,
  })
  const traceStore = createTraceStore({
    ...options,
    now,
    runtime,
    live,
    limits: options.limits?.activity,
  })
  const traces = new TraceRecorder({
    context,
    store: traceStore,
    runtime,
    live,
    capacity: options.limits?.recorderQueue ?? 2_048,
  })
  const emergency = options.emergencySink ?? process.stderr.write.bind(process.stderr)
  return {
    runtime,
    traces,
    traceStore,
    live,
    close: async () => {
      for (const close of [() => traces.flush(), () => traceStore.close(), () => runtime.close()]) {
        try {
          await close()
        } catch (error) {
          emergency(defaultRedactor.redactError(error))
        }
      }
    },
  }
}
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-context.test.ts src/trace-recorder.test.ts src/diagnostics.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit correlation and recording**

```bash
git add packages/daemon/src/trace-context.ts packages/daemon/src/trace-context.test.ts packages/daemon/src/trace-recorder.ts packages/daemon/src/trace-recorder.test.ts packages/daemon/src/diagnostics.ts packages/daemon/src/diagnostics.test.ts
git commit -m "feat(daemon): record correlated trace lifecycles (issue #50)"
```

### Task 7: Wire Runtime logging into Gateway boot and operational call sites

**Files:**

- Modify: `packages/daemon/src/server.ts:145-230,449-510,1783-1805`
- Modify: `packages/daemon/src/index.ts:13-74,88-163,176-216`
- Modify: `packages/daemon/src/redaction.ts:125-158`
- Modify: `packages/daemon/src/redaction.test.ts:137-172`
- Modify operational call sites in:
  `allowlist-surface.ts`, `approval-surface.ts`, `chat-loop.ts`, `codex-app-server.ts`,
  `event-ingestion.ts`, `notification-center.ts`, `notification-settings-surface.ts`,
  `scheduler.ts`, `session-flush.ts`, `spaces-engine.ts`, `surface-engine.ts`,
  `template-engine.ts`, `tree-proposal.ts`, `update-manager.ts`, `watch-renewal.ts`, and
  `web-push-transport.ts`.
- Modify matching colocated tests that spy on `console`.

**Interfaces:**

- Consumes: `createDiagnostics`, `setActiveRuntimeLogger`, `runtimeLog`,
  `installFatalRuntimeLogging`.
- `buildServer` returns `diagnostics` and accepts
  `diagnosticsFactory?: (options: CreateDiagnosticsOptions) => Diagnostics` for deterministic
  failure tests.

- [ ] **Step 1: Write failing Gateway/process integration tests**

Add tests proving `buildServer({ dataDir })` creates Runtime files in
`<dataDir>/diagnostics/runtime`, all four levels reach an injected journal sink, `app.close()`
flushes/closes diagnostics, and an operational error carries the current `traceId`. Add a static
test that the VPS-profile boot path never prints a setup URL/code while Local VPS still emits the terminal
setup line required by `packages/e2e/tests/stack.ts`.

```ts
it('owns diagnostics for the complete Gateway lifetime', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'veduta-diagnostics-'))
  const { app, diagnostics } = buildServer({ dataDir })
  diagnostics.runtime.info('gateway-test', 'ready')
  await app.close()
  const runtimeDir = join(dataDir, 'diagnostics', 'runtime')
  expect((await readdir(runtimeDir)).some((name) => name.endsWith('.jsonl'))).toBe(true)
})

it('does not expose production bootstrap material through process output', async () => {
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  expect(source).toMatch(/startVps[\s\S]*emitSetupUrl:\s*false/)
  expect(source).toMatch(/startLocalVps[\s\S]*emitSetupUrl:\s*true/)
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/runtime-log.test.ts src/server.test.ts src/local-vps-script.test.ts`

Expected: FAIL on missing Gateway diagnostics wiring.

- [ ] **Step 3: Construct diagnostics after the data-version gate and before product stores**

```ts
const dataDir = resolveDataDir(options.dataDir)
ensureDataVersion(dataDir)
const diagnostics = (options.diagnosticsFactory ?? createDiagnostics)({ rootDir: dataDir, now })
const disposeActiveLogger = setActiveRuntimeLogger(diagnostics.runtime)
app.addHook('onClose', async () => {
  await diagnostics.close()
  disposeActiveLogger()
})
```

Register this close hook before product-store hooks so Fastify's reverse close order stops chat,
Workers, scheduler, ingestion, and other writers before diagnostics flushes last. Return
`diagnostics` from `buildServer` for integration assertions.

- [ ] **Step 4: Replace non-CLI operational `console.*` calls**

For every listed file, import `runtimeLog` and preserve the existing safe message while adding a
stable component. Example:

```ts
runtimeLog.error('event-ingestion', `reader handoff failed for queue #${row.id}; will retry`, {
  error,
})
```

Do not pass raw HTTP bodies, headers, environment objects, provider envelopes, or child stderr.
Update console-spy tests to inject/set a recording Runtime logger and assert component, level, and
redacted error fields.

- [ ] **Step 5: Install fatal monitoring without swallowing crashes**

Call `installFatalRuntimeLogging(process)` at daemon startup. Keep readiness lines as explicit
operator output and also write a separate safe `runtimeLog.info('daemon', 'Gateway listening',
{ profile, port })` without setup codes. Do not add an `uncaughtException` handler.

Change `buildProductionAuth` to accept `emitSetupUrl`; pass `true` only from `startLocalVps` and
`false` from `startVps`. The production installer already owns and prints its generated code, so
production `journald` no longer receives it.

```ts
const disposeFatalLogging = installFatalRuntimeLogging(process)
try {
  const auth = buildProductionAuth({ ...options, emitSetupUrl: accessMode === 'local-vps' })
  runtimeLog.info('daemon', 'Gateway listening', { profile, port })
  await app.listen({ host, port })
} finally {
  disposeFatalLogging()
}
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/runtime-log.test.ts src/redaction.test.ts src/server.test.ts src/local-vps-script.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit process wiring**

```bash
git add \
  packages/daemon/src/index.ts \
  packages/daemon/src/server.ts \
  packages/daemon/src/redaction.ts \
  packages/daemon/src/redaction.test.ts \
  packages/daemon/src/allowlist-surface.ts \
  packages/daemon/src/approval-surface.ts \
  packages/daemon/src/chat-loop.ts \
  packages/daemon/src/codex-app-server.ts \
  packages/daemon/src/codex-app-server.test.ts \
  packages/daemon/src/event-ingestion.ts \
  packages/daemon/src/notification-center.ts \
  packages/daemon/src/notification-center.test.ts \
  packages/daemon/src/notification-settings-surface.ts \
  packages/daemon/src/notification-settings-surface.test.ts \
  packages/daemon/src/scheduler.ts \
  packages/daemon/src/session-flush.ts \
  packages/daemon/src/session-flush.test.ts \
  packages/daemon/src/spaces-engine.ts \
  packages/daemon/src/surface-engine.ts \
  packages/daemon/src/template-engine.ts \
  packages/daemon/src/tree-proposal.ts \
  packages/daemon/src/update-manager.ts \
  packages/daemon/src/update-manager.test.ts \
  packages/daemon/src/watch-renewal.ts \
  packages/daemon/src/web-push-transport.ts \
  packages/daemon/src/web-push-transport.test.ts
git commit -m "feat(daemon): route operations through runtime logging (issue #50)"
```

Before committing, inspect `git diff --cached --name-only` and unstage any CLI-only or unrelated
file. The staged set must contain only the explicit files in this task.

### Task 8: Expose authenticated retained diagnostic REST APIs

**Files:**

- Create: `packages/daemon/src/trace-reader.ts`
- Create: `packages/daemon/src/trace-reader.test.ts`
- Create: `packages/daemon/src/trace-routes.ts`
- Create: `packages/daemon/src/trace-routes.test.ts`
- Create: `packages/daemon/src/trace-routes.auth.test.ts`
- Modify: `packages/daemon/src/diagnostics.ts`
- Modify: `packages/daemon/src/diagnostics.test.ts`
- Modify: `packages/daemon/src/server.ts:1375-1622`

**Interfaces:**

- Consumes: `Diagnostics.traceStore`, `Diagnostics.runtime`, all Task 1 REST schemas.
- Produces `registerTraceRoutes(app, { reader })` for the four approved GET surfaces.
- Produces `DiagnosticReplay { messages: TraceSocketServerMessage[]; lastCursor?: string }` and
  adds `reader: TraceReader` to `Diagnostics` during `createDiagnostics`.
- Produces `DiagnosticNotFoundError` with `kind: 'trace' | 'runtime-segment'`; route handlers map
  only that error to `404` and rethrow every other failure.

- [ ] **Step 1: Write failing reader and route tests**

Assert default/capped pagination, every Activity filter, progressive Trace detail, one Runtime
segment at a time, unknown segment/Trace `404`, invalid query `400`, source mismatch as a visible
gap, `Cache-Control: no-store`, no filesystem paths, and response-schema validation.

Add a production-auth table for:

```ts
const routes = [
  '/api/trace-events',
  `/api/traces/${TRACE_ID}`,
  '/api/runtime-log-segments',
  `/api/runtime-log-segments/${SEGMENT_ID}`,
]
```

Unauthenticated responses are `401`; valid Bearer-session responses are never `401/403`.
Assert both successful and unauthenticated responses carry `Cache-Control: no-store`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-reader.test.ts src/trace-routes.test.ts src/trace-routes.auth.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the reader facade**

```ts
export class DiagnosticNotFoundError extends Error {
  constructor(
    readonly kind: 'trace' | 'runtime-segment',
    readonly id: string,
  ) {
    super(`${kind === 'trace' ? 'Trace' : 'Runtime segment'} not found: ${id}`)
  }
}

export class TraceReader {
  search(query: TraceSearchQuery): TraceEventsPage {
    return this.traces.search(query)
  }
  trace(traceId: string, query: TraceDetailQuery): TraceDetailPage {
    const page = this.traces.readTrace(traceId, query)
    if (!page) throw new DiagnosticNotFoundError('trace', traceId)
    return page
  }
  runtimeSegments(): RuntimeLogSegmentsResponse {
    return this.runtime.listSegmentsResponse()
  }
  runtimeSegment(id: string): RuntimeLogSegmentResponse {
    const segment = this.runtime.readSegmentResponse(id)
    if (!segment) throw new DiagnosticNotFoundError('runtime-segment', id)
    return segment
  }
  replay(view: DiagnosticView, cursor: string | undefined, limit: number): DiagnosticReplay {
    const replay =
      view === 'activity'
        ? this.traces.replayAfter(cursor, limit)
        : this.runtime.replayAfter(cursor, limit)
    return {
      messages: replay.items.map(({ cursor, record }) =>
        TraceSocketServerMessageSchema.parse({ type: view, cursor, record }),
      ),
      ...(replay.lastCursor ? { lastCursor: replay.lastCursor } : {}),
    }
  }
}

const reader = new TraceReader(traceStore, runtime)
return { runtime, traces, traceStore, reader, live, close }
```

- [ ] **Step 4: Register thin, validated no-store routes**

Parse query/params with protocol schemas, call only the reader, parse the response schema, and set
`reply.header('cache-control', 'no-store')` before every success or diagnostic error response.
Register on the top-level Fastify instance after the existing `onRequest` hook; do not add these
REST paths to `isPublicUnauthenticatedPath`.

Before the authentication hook is registered, add a narrow top-level `onRequest` hook that sets
`no-store` for the four diagnostic REST prefixes. This makes even an authentication `401`
non-cacheable; route-level hooks would run too late after an auth rejection.

```ts
export function registerTraceRoutes(app: FastifyInstance, options: { reader: TraceReader }): void {
  app.get('/api/trace-events', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const query = TraceSearchQuerySchema.safeParse(request.query)
    if (!query.success) return reply.status(400).send({ error: query.error.issues })
    return TraceEventsPageSchema.parse(options.reader.search(query.data))
  })
  app.get('/api/traces/:traceId', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const params = z.object({ traceId: z.string().uuid() }).safeParse(request.params)
    const query = TraceDetailQuerySchema.safeParse(request.query)
    if (!params.success || !query.success)
      return reply.status(400).send({ error: 'invalid Trace request' })
    try {
      return TraceDetailPageSchema.parse(options.reader.trace(params.data.traceId, query.data))
    } catch (error) {
      if (error instanceof DiagnosticNotFoundError)
        return reply.status(404).send({ error: error.message })
      throw error
    }
  })
  app.get('/api/runtime-log-segments', async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return RuntimeLogSegmentsResponseSchema.parse(options.reader.runtimeSegments())
  })
  app.get('/api/runtime-log-segments/:segmentId', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const params = z
      .object({
        segmentId: z.string().regex(/^seg-[0-9]{16}$/),
      })
      .safeParse(request.params)
    if (!params.success) return reply.status(400).send({ error: params.error.issues })
    try {
      return RuntimeLogSegmentResponseSchema.parse(
        options.reader.runtimeSegment(params.data.segmentId),
      )
    } catch (error) {
      if (error instanceof DiagnosticNotFoundError)
        return reply.status(404).send({ error: error.message })
      throw error
    }
  })
}

const isDiagnosticRestPath = (path: string): boolean =>
  path === '/api/trace-events' ||
  path.startsWith('/api/traces/') ||
  path === '/api/runtime-log-segments' ||
  path.startsWith('/api/runtime-log-segments/')

app.addHook('onRequest', (request, reply, done) => {
  if (isDiagnosticRestPath(request.url.split('?', 1)[0]!)) {
    reply.header('cache-control', 'no-store')
  }
  done()
})
// Register the existing Bearer-session onRequest hook after this one.
```

- [ ] **Step 5: Run focused and Gateway authentication tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-reader.test.ts src/trace-routes.test.ts src/trace-routes.auth.test.ts src/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit retained read APIs**

```bash
git add packages/daemon/src/trace-reader.ts packages/daemon/src/trace-reader.test.ts packages/daemon/src/trace-routes.ts packages/daemon/src/trace-routes.test.ts packages/daemon/src/trace-routes.auth.test.ts packages/daemon/src/diagnostics.ts packages/daemon/src/diagnostics.test.ts packages/daemon/src/server.ts
git commit -m "feat(daemon): expose retained trace APIs (issue #50)"
```

### Task 9: Add the dedicated authenticated realtime channel

**Files:**

- Create: `packages/daemon/src/trace-socket.ts`
- Create: `packages/daemon/src/trace-socket.test.ts`
- Modify: `packages/daemon/src/server.ts:1727-1738,1816-1841`
- Modify: `packages/daemon/src/server.test.ts`

**Interfaces:**

- Produces `TraceSocketHub.connect(socket)` and `close()`.
- Consumes the same `verifySession`/`onSessionRevoked` shape as `GatewayHub`, `TraceReader.replay`,
  and `DiagnosticLiveBroker`.

- [ ] **Step 1: Write failing socket tests**

Use a fake socket with `send`, `close`, message/close listeners, and mutable `bufferedAmount`.
Prove: origin rejection, ten-second hello deadline, invalid frame closure, production token
verification, dev hello without token, one active-view subscription, Activity/Runtime switching,
retained replay, expired-cursor gap, 256-frame/1 MiB backpressure gap, and device revocation closure.

```ts
interface TraceSocketTestDouble {
  sent: TraceSocketServerMessage[]
  bufferedAmount: number
  send(value: string): void
  close: ReturnType<typeof vi.fn>
  on(event: string, listener: (value?: unknown) => void): void
  emit(event: string, value?: unknown): void
}
function fakeSocket(): TraceSocketTestDouble {
  const listeners = new Map<string, Array<(value?: unknown) => void>>()
  return {
    sent: [],
    bufferedAmount: 0,
    send(value) {
      this.sent.push(JSON.parse(String(value)))
    },
    close: vi.fn(),
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event, value) {
      for (const listener of listeners.get(event) ?? []) listener(value)
    },
  }
}

it('authenticates in hello and replaces the active subscription', () => {
  const activityRecord = TraceEventSchema.parse({
    schemaVersion: 1,
    eventId: '11111111-1111-4111-8111-111111111111',
    traceId: '22222222-2222-4222-8222-222222222222',
    stepId: '33333333-3333-4333-8333-333333333333',
    at: '2026-08-10T12:00:00.000Z',
    kind: 'trace.started',
    operationKind: 'chat',
    component: 'chat-loop',
    summary: 'Chat turn',
  })
  const runtimeRecord = RuntimeLogRecordSchema.parse({
    schemaVersion: 1,
    recordId: '44444444-4444-4444-8444-444444444444',
    at: '2026-08-10T12:00:01.000Z',
    level: 'INFO',
    component: 'gateway',
    message: 'Ready',
  })
  const socket = fakeSocket()
  hub.connect(socket)
  socket.emit(
    'message',
    JSON.stringify({ type: 'hello', token: 'vdt_test-session', view: 'activity' }),
  )
  socket.emit('message', JSON.stringify({ type: 'subscribe', view: 'runtime' }))
  live.publish({ view: 'activity', cursor: 'activity-cursor', record: activityRecord })
  live.publish({ view: 'runtime', cursor: 'runtime-cursor', record: runtimeRecord })
  expect(socket.sent).toContainEqual(expect.objectContaining({ type: 'runtime' }))
  expect(socket.sent).not.toContainEqual(expect.objectContaining({ type: 'activity' }))
})
```

- [ ] **Step 2: Run the socket test and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-socket.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement first-message auth and replaceable subscriptions**

```ts
if (frame.type === 'hello') {
  const session = this.auth?.verifySession(frame.token)
  if (this.auth && !session) return rejectAndClose('authenticated Trace session required')
  client.view = frame.view
  this.replaceSubscription(client, frame.view)
  this.replay(client, frame.cursor)
  return
}
if (frame.type === 'subscribe') {
  client.view = frame.view
  this.replaceSubscription(client, frame.view)
  this.replay(client, frame.cursor)
}

const toSocketMessage = (item: DiagnosticLiveItem): TraceSocketServerMessage =>
  'state' in item
    ? { type: 'state', view: item.view, state: item.state }
    : { type: item.view, cursor: item.cursor, record: item.record }
```

Serialize every outgoing frame through `TraceSocketServerMessageSchema`. Drain per-client queues
with `queueMicrotask`; when a queue or `bufferedAmount` crosses its bound, discard queued live
records, enqueue one counted backpressure gap, and continue persistence independently.

- [ ] **Step 4: Register `/ws/trace` safely**

Add a separate WebSocket route with the existing production origin check. Add only `/ws/trace` to
`isPublicUnauthenticatedPath` because the browser handshake has no Authorization header; the hub's
hello performs auth. Add an `onClose` hook that closes the hub after producers stop.

```ts
app.get('/ws/trace', { websocket: true }, (socket, request) => {
  if (auth && !isAllowedOrigin(request.headers.origin, auth.allowedOrigins)) {
    socket.close(1008, 'origin not allowed')
    return
  }
  traceSocketHub.connect(socket)
})

// Extend the existing return expression in isPublicUnauthenticatedPath:
path === '/ws/gateway' ||
  path === '/ws/trace' ||
  app.addHook('onClose', () => traceSocketHub.close())
```

- [ ] **Step 5: Run focused and Gateway tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/trace-socket.test.ts src/server.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit realtime transport**

```bash
git add packages/daemon/src/trace-socket.ts packages/daemon/src/trace-socket.test.ts packages/daemon/src/server.ts packages/daemon/src/server.test.ts
git commit -m "feat(daemon): stream opt-in trace records (issue #50)"
```

### Task 10: Trace committed mutations and fast-path roots

**Files:**

- Modify: `packages/daemon/src/spaces-engine.ts:88-108,132-143,320-340,699-734`
- Modify: `packages/daemon/src/spaces-engine.test.ts`
- Modify: `packages/daemon/src/store.ts:138-145`
- Modify: `packages/daemon/src/store.test.ts`
- Create: `packages/daemon/src/trace-instrumentation.ts`
- Create: `packages/daemon/src/trace-instrumentation.test.ts`
- Modify: `packages/daemon/src/server.ts:555-567,1623-1686`

**Interfaces:**

- Produces `SpacesEngine.onEventAppended(observer: (event: SpaceEvent) => void): () => void` and
  `Store.onEventAppended`.
- Produces `installStoreTraceInstrumentation(store, recorder): () => void`.

- [ ] **Step 1: Write failing committed-observer and fast-path tests**

Assert `onEventAppended` fires exactly once after a successful append, not after a failed append,
and swallows observer failure after logging it. In a `buildServer` fixture, invoke a declared fast
action and assert one root Trace contains both a Surface step and the matching Event log step with
the same `traceId`; an idempotent duplicate does not fabricate a second mutation step.

```ts
it('notifies Event observers exactly once after the append commits', () => {
  const observed: SpaceEvent[] = []
  engine.onEventAppended((event) => observed.push(event))
  const committed = engine.appendEvent('spc-home', { type: 'turn', text: 'Done' })
  expect(observed).toEqual([committed])
  engine.onEventAppended(() => {
    throw new Error('observer failure')
  })
  expect(() =>
    engine.appendEvent('spc-home', { type: 'turn', text: 'Still committed' }),
  ).not.toThrow()
})

it('correlates a fast-path Surface change with its Event log append', async () => {
  const { app, diagnostics } = buildServer({ dataDir })
  await app.inject({
    method: 'POST',
    url: `/api/surfaces/${SURFACE_ID}/actions`,
    payload: DECLARED_FAST_ACTION,
    headers: AUTH_HEADERS,
  })
  await diagnostics.traces.flush()
  const page = diagnostics.traceStore.search({ q: 'Fast Surface action', limit: 100 })
  const detail = diagnostics.traceStore.readTrace(page.items[0]!.traceId, { limit: 100 })
  expect(detail.events.some((event) => event.details?.family === 'surface')).toBe(true)
  expect(detail.events.some((event) => event.details?.family === 'event-log')).toBe(true)
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/spaces-engine.test.ts src/store.test.ts src/trace-instrumentation.test.ts src/server.test.ts`

Expected: FAIL on the missing Event observer/instrumentation.

- [ ] **Step 3: Add the post-commit Event observer**

After `appendFileSync` succeeds, notify Event observers with the validated `SpaceEvent`, then notify
memory observers. Catch each diagnostic observer independently through `runtimeLog.error`; never
change the already-committed append result.

```ts
private readonly eventObservers = new Set<(event: SpaceEvent) => void>()

onEventAppended(observer: (event: SpaceEvent) => void): () => void {
  this.eventObservers.add(observer)
  return () => this.eventObservers.delete(observer)
}

// In Store, delegate without duplicating observer state.
onEventAppended(observer: (event: SpaceEvent) => void): () => void {
  return this.spacesEngine.onEventAppended(observer)
}

private notifyEventAppended(event: SpaceEvent): void {
  for (const observer of this.eventObservers) {
    try { observer(event) }
    catch (error) { runtimeLog.error('spaces-engine', 'Event observer failed', { error }) }
  }
}

appendFileSync(this.logPath(space, at), `${JSON.stringify(event)}\n`)
this.notifyEventAppended(event)
this.notifyMemoryWrite(space.id, 'event')
```

- [ ] **Step 4: Map central Event and Surface observers to instant steps**

```ts
const disposeEvent = store.onEventAppended((event) =>
  recorder.recordInstantStep({
    operationKind: 'event-log',
    component: 'spaces-engine',
    summary: `Append ${event.type} Event`,
    spaceId: event.spaceId,
    details: { family: 'event-log', eventType: event.type },
  }),
)
const disposeSurface = store.onSurfaceEvent(({ kind, event }) =>
  recorder.recordInstantStep({
    operationKind: 'surface',
    component: 'surface-engine',
    summary: `${kind} Surface`,
    spaceId: event.spaceId,
    details: { family: 'surface', change: kind, surfaceId: event.surfaceId, cursor: event.cursor },
  }),
)
return () => {
  disposeSurface()
  disposeEvent()
}
```

Use field access matching each existing `SurfaceEngineEvent` variant; do not cast the union.

- [ ] **Step 5: Wrap authenticated fast actions and pinning in roots**

Change handlers to `async` and call `diagnostics.traces.runRoot` with safe summaries (`Fast Surface
action`, `Pin Surface`), `spaceId` resolved by the Gateway, and lifecycle details that contain IDs but
not request payload. Preserve all existing status/error mappings.

```ts
app.post('/api/surfaces/:surfaceId/actions', async (request, reply) => {
  const { surfaceId } = request.params as { surfaceId: string }
  const parsed = SurfaceActionBodySchema.safeParse(request.body)
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.issues })
  const surface = store.getSurface(surfaceId)
  return diagnostics.traces.runRoot(
    {
      operationKind: 'fast-path',
      component: 'surface-engine',
      summary: 'Fast Surface action',
      ...(surface ? { spaceId: surface.spaceId } : {}),
      details: {
        family: 'lifecycle',
        phase: 'fast-action',
        attributes: { surfaceId, nodeId: parsed.data.nodeId, action: parsed.data.name },
      },
    },
    async () => {
      try {
        const result = store.invokeSurfaceAction(surfaceId, parsed.data)
        if (result.path === 'agent') return reply.status(202).send({ turn: result.turn })
        return { surface: result.mutation.surface }
      } catch (error) {
        if (error instanceof SurfaceActionError) {
          return reply.status(statusForSurfaceActionError(error)).send({ error: error.message })
        }
        throw error
      }
    },
  )
})
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/spaces-engine.test.ts src/store.test.ts src/trace-instrumentation.test.ts src/server.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit mutation instrumentation**

```bash
git add packages/daemon/src/spaces-engine.ts packages/daemon/src/spaces-engine.test.ts packages/daemon/src/store.ts packages/daemon/src/store.test.ts packages/daemon/src/trace-instrumentation.ts packages/daemon/src/trace-instrumentation.test.ts packages/daemon/src/server.ts packages/daemon/src/server.test.ts
git commit -m "feat(daemon): trace committed mutations (issue #50)"
```

### Task 11: Trace chat, model attempts, failover, usage, and tools

**Files:**

- Modify: `packages/daemon/src/model-routing.ts:361-418,431-520`
- Modify: `packages/daemon/src/model-routing.test.ts`
- Modify: `packages/daemon/src/agent-runner.ts:30-58`
- Modify: `packages/daemon/src/pi-agent-runner.ts:154-210,267-278,474-487,525-588,805-828`
- Modify: `packages/daemon/src/pi-agent-runner.test.ts`
- Modify: `packages/daemon/src/chat-loop.ts:33-68,155-329`
- Modify: `packages/daemon/src/chat-loop.test.ts`
- Modify: `packages/daemon/src/server.ts:889-916,1205-1218`
- Modify: `packages/daemon/src/subscription-failover.test.ts`

**Interfaces:**

- `ModelRouterOptions` gains `traces?: TraceRecorder`; every candidate is one model step.
- `PiAgentRunnerOptions` gains `traces?: TraceRecorder`; every tool handler is one nested tool step.
- `AgentEvent` `turn-end` gains optional provider-emitted `reasoning` and
  optional `sessionEntryIds: string[]`; the latter contains only IDs returned by `SessionStore.append`,
  never message content.
- `ChatLoopOptions` gains `traces: TraceRecorder`; every accepted chat message is one root with
  Gateway-derived `sessionId` and optional `spaceId`.
- Rename the current private `runTurn(event, spaceId)` closure to
  `executeTurn(event, spaceId, sessionId)` without changing its frame, Event log, or error body;
  the new `runTurn` is the Trace wrapper shown below.

- [ ] **Step 1: Write failing model/tool/chat tests**

Prove:

- primary failure plus secondary success produces an ERROR model step, failover annotation,
  successful model step, and COMPLETED root;
- non-retryable or exhausted routing produces an ERROR root;
- a tool start/result encloses committed Surface/Event log child steps;
- cost/tokens appear only when provider-reported and missing values remain absent;
- provider-emitted thinking text is optional, redacted, and attached only to the model step;
- Session transcript content is absent while returned Session entry IDs stay on their originating
  model step;
- text deltas create no Trace records.

```ts
it('keeps a failed model attempt inside a completed failover Trace', async () => {
  const result = await recorder.runRoot(
    { operationKind: 'chat', component: 'chat-loop', summary: 'Chat turn' },
    () =>
      router.execute({ purpose: 'chat-turn', origin: 'user' }, async (_model, attempt) => {
        if (attempt === 0) throw new Error('temporary')
        return 'ok'
      }),
  )
  expect(result).toBe('ok')
  await recorder.flush()
  expect(
    events.filter((event) => event.operationKind === 'model').map((event) => event.kind),
  ).toEqual(['step.started', 'step.failed', 'step.started', 'step.completed'])
  expect(events.at(-1)?.kind).toBe('trace.completed')
})

it('does not turn streamed text deltas into Activity', async () => {
  await chat.handleChatMessage({
    adapterId: 'pwa',
    clientId: 'client-1',
    text: 'hello',
    receivedAt: '2026-08-10T12:00:00.000Z',
  })
  await diagnostics.traces.flush()
  expect(traceEvents.some((event) => event.kind.includes('delta'))).toBe(false)
  expect(traceEvents.filter((event) => event.kind === 'trace.started')).toHaveLength(1)
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/model-routing.test.ts src/pi-agent-runner.test.ts src/chat-loop.test.ts src/subscription-failover.test.ts`

Expected: FAIL.

- [ ] **Step 3: Wrap each routed candidate in a model step**

```ts
return this.traces
  ? this.traces.runStep(
      {
        operationKind: 'model',
        component: 'model-router',
        summary: `Call ${model.provider}`,
        ...(request.spaceId ? { spaceId: request.spaceId } : {}),
        ...(request.workerId ? { workerId: request.workerId } : {}),
        details: {
          family: 'model',
          attempt,
          provider: model.provider,
          modelId: model.modelId,
          tier,
          ...(model.connectionId ? { connectionId: model.connectionId } : {}),
        },
      },
      () => fn(model, attempt),
    )
  : fn(model, attempt)
```

On catch, annotate the current model step with the sanitized retry decision; keep
`ModelRouter.execute`'s existing retry/non-retry behavior and `RouterEvent` system notice exactly
once.

- [ ] **Step 4: Wrap tool execution inside `pi-agent-runner.ts`**

Pass the optional recorder into `toPiAgentTool`. It runs the already-validated handler inside
`traces.runStep`, includes tool name/call ID and sanitized bounded input, then annotates the same
step with result/isError. Preserve taint accumulation, effect IDs, session persistence, sequential
execution, and the no-failover-after-tool rule.

Extract only explicit `thinking` content blocks from the final provider message into the optional
`AgentEvent.turn-end.reasoning`; do not derive or summarize reasoning.

Capture each `SessionStore.append` return value in `currentModelCallEntryIds`, seed a failover retry
with the already-persisted user entry ID, emit a copy on `turn-end`, then clear the array for the
next model call. Never put `SessionMessage.content` in a Trace.

```ts
export function toPiAgentTool(
  tool: ToolDef,
  parameters: PiToolParameters,
  buildContext: (toolCallId: string, signal?: AbortSignal) => ToolContext,
  recordToolOrigins: (toolCallId: string, origins: Origin[]) => void,
  traces?: TraceRecorder,
): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters,
    execute: async (toolCallId, params, signal) => {
      const parsedResult = tool.schema.safeParse(params)
      if (!parsedResult.success) throw new Error(parsedResult.error.message)
      const parsed = parsedResult.data
      const execute = async () => {
        const context = buildContext(toolCallId, signal)
        const result = await tool.handler(parsed, context)
        if (result.origins?.length) {
          for (const origin of result.origins) context.taint.add(origin)
          recordToolOrigins(toolCallId, result.origins)
        }
        traces?.annotateCurrent({
          details: {
            family: 'tool',
            toolCallId,
            toolName: tool.name,
            result: { value: result.details ?? null },
            isError: false,
          },
        })
        return toPiToolResult(result)
      }
      return traces
        ? traces.runStep(
            {
              operationKind: 'tool',
              component: 'agent-runner',
              summary: `Run ${tool.name}`,
              details: { family: 'tool', toolCallId, toolName: tool.name, input: parsed },
            },
            execute,
          )
        : execute()
    },
  }
}

function piMessageReasoning(message: AgentMessage): string | undefined {
  if (!('content' in message) || !Array.isArray(message.content)) return undefined
  const text = message.content
    .flatMap((block) =>
      isRecord(block) && block['type'] === 'thinking' && typeof block['thinking'] === 'string'
        ? [block['thinking']]
        : [],
    )
    .join('\n')
    .trim()
  return text === '' ? undefined : text
}

const entry = await this.sessionStore.append(sessionId, { type: 'message', message: stamped })
this.currentModelCallEntryIds.push(entry.id)

await this.events.emit({
  type: 'turn-end',
  sessionId,
  model,
  text,
  sessionEntryIds: [...this.currentModelCallEntryIds],
  ...(reasoning === undefined ? {} : { reasoning }),
})
this.currentModelCallEntryIds = []
```

- [ ] **Step 5: Wrap the logical chat turn and annotate model usage**

Move the existing body of `runTurn` inside `traces.runRoot({ operationKind: 'chat', ... })`. Use
`summary: 'Chat turn'`, never `event.text`. In the existing `turn-end` subscriber call
`annotateCurrent` with only fields actually present (`costUsd`, `tokensUsed`, `reasoning`). Keep
turn frame order, session serialization, Event log appends, and error sanitization unchanged.

```ts
async function runTurn(event: NormalizedChannelEvent, spaceId: string | undefined): Promise<void> {
  const sessionId = sessionIdFor(spaceId)
  await options.traces.runRoot(
    {
      operationKind: 'chat',
      component: 'chat-loop',
      summary: 'Chat turn',
      sessionId,
      ...(spaceId ? { spaceId } : {}),
    },
    () => executeTurn(event, spaceId, sessionId),
  )
}

if (agentEvent.type === 'turn-end') {
  const attributes = {
    ...(agentEvent.costUsd === undefined ? {} : { costUsd: agentEvent.costUsd }),
    ...(agentEvent.tokensUsed === undefined ? {} : { tokensUsed: agentEvent.tokensUsed }),
    ...(agentEvent.reasoning === undefined ? {} : { reasoning: agentEvent.reasoning }),
    ...(agentEvent.sessionEntryIds === undefined
      ? {}
      : { sessionEntryIds: agentEvent.sessionEntryIds }),
  }
  const details = { family: 'lifecycle' as const, phase: 'model-result', attributes }
  options.traces.annotateCurrent({ details })
}
```

- [ ] **Step 6: Pass one recorder from `server.ts`**

Supply `diagnostics.traces` to `ModelRouter`, every `PiAgentRunner` construction path used by chat
and Workers, and `createChatLoop`. Do not construct local recorders in feature modules.

```ts
const router = new ModelRouter({ ...routerOptions, traces: diagnostics.traces })
const chat = createChatLoop({ ...chatOptions, router, traces: diagnostics.traces })
const runner = new PiAgentRunner({ ...runnerOptions, traces: diagnostics.traces })
```

- [ ] **Step 7: Run focused and integration tests**

Run: `pnpm --filter @veduta/daemon exec vitest run src/model-routing.test.ts src/pi-agent-runner.test.ts src/chat-loop.test.ts src/subscription-failover.test.ts src/server.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit core Agent instrumentation**

```bash
git add packages/daemon/src/model-routing.ts packages/daemon/src/model-routing.test.ts packages/daemon/src/agent-runner.ts packages/daemon/src/pi-agent-runner.ts packages/daemon/src/pi-agent-runner.test.ts packages/daemon/src/chat-loop.ts packages/daemon/src/chat-loop.test.ts packages/daemon/src/server.ts packages/daemon/src/subscription-failover.test.ts
git commit -m "feat(daemon): trace agent turns and tools (issue #50)"
```

### Task 12: Trace durable background work, approvals, deliveries, and updates

**Files:**

- Modify: `packages/daemon/src/scheduler.ts` and `scheduler.test.ts`
- Modify: `packages/daemon/src/worker.ts` and `worker.test.ts`
- Modify: `packages/daemon/src/event-ingestion.ts` and `event-ingestion.test.ts`
- Modify: `packages/daemon/src/notification-center.ts` and `notification-center.test.ts`
- Modify: `packages/daemon/src/approval-surface.ts` and `approval-surface.test.ts`
- Modify: `packages/daemon/src/trust-layer.ts` and `trust-layer.test.ts`
- Modify: `packages/daemon/src/update-manager.ts` and `update-manager.test.ts`
- Modify: `packages/daemon/src/server.ts:576-650,626-660,995-1037,1080-1180,1239-1373`

**Interfaces:**

- Each options object gains one optional `traces?: TraceRecorder` to preserve isolated unit tests.
- Durable asynchronous work receives a new root. If spawned inside another Trace, capture its
  `traceId` immediately and pass it as `parentTraceId`; never retain an `ActiveTraceScope` object.

- [ ] **Step 1: Write failing boundary tests**

Add one test per subsystem:

- Scheduler occurrence root includes `automationId`, scheduled time, outcome, and error.
- Worker asynchronous run gets a new `traceId` and the spawning chat Trace as `parentTraceId`.
- Webhook/boot-redelivery roots include trusted source/queue IDs but no raw event body.
- Notification decision is a child step; outbox delivery is a root after restart.
- Approval creation records pending; a later approve/reject/expiry records a distinct resolution
  root linked by `approvalId`.
- Update check/apply/outcome are roots or steps with version/outcome but no feed body or process
  environment.

```ts
it('detaches a Worker while retaining only parent Trace correlation', async () => {
  let workerId = ''
  await traces.runRoot(
    { operationKind: 'chat', component: 'chat-loop', summary: 'Chat turn' },
    async () => {
      workerId = pool.spawn(WORKER_ARGS).workerId
    },
  )
  await pool.whenSettled(workerId)
  await traces.flush()
  const chatRoot = events.find(
    (event) => event.kind === 'trace.started' && event.operationKind === 'chat',
  )!
  const workerRoot = events.find(
    (event) => event.kind === 'trace.started' && event.operationKind === 'worker',
  )!
  expect(workerRoot.traceId).not.toBe(chatRoot.traceId)
  expect(workerRoot.parentTraceId).toBe(chatRoot.traceId)
  expect(workerRoot.parentStepId).toBeUndefined()
})

it('does not duplicate raw webhook content into Trace detail', async () => {
  await pipeline.handleWebhook(
    'mail',
    signedInput(emailPayload({ subject: 'secretBody-sentinel' })),
  )
  await traces.flush()
  expect(JSON.stringify(events)).not.toContain('secretBody')
  expect(events.some((event) => event.operationKind === 'external-event')).toBe(true)
})
```

- [ ] **Step 2: Run subsystem tests and verify failure**

Run: `pnpm --filter @veduta/daemon exec vitest run src/scheduler.test.ts src/worker.test.ts src/event-ingestion.test.ts src/notification-center.test.ts src/approval-surface.test.ts src/trust-layer.test.ts src/update-manager.test.ts`

Expected: FAIL.

- [ ] **Step 3: Wrap scheduler and Worker durable roots**

In `Scheduler.runOccurrence`, call `runRoot` after a claim succeeds and include the Automation ID,
Space, and scheduled instant. In `WorkerPool.spawn`, capture `parentTraceId`, leave Surface creation
and `worker.spawned` inside the spawning tool step, then run `this.run` in a detached Worker root
with `workerId`, `sessionId`, and Space. Preserve cancellation, budget, recovery, and settle order.

```ts
const runOccurrence = () => this.executeClaimedOccurrence(automation, scheduledFor)
await (this.traces
  ? this.traces.runRoot(
      {
        operationKind: 'automation',
        component: 'scheduler',
        summary: 'Run Automation',
        automationId: automation.id,
        spaceId: automation.spaceId,
        details: {
          family: 'lifecycle',
          phase: 'automation-occurrence',
          attributes: { scheduledFor },
        },
      },
      runOccurrence,
    )
  : runOccurrence())

const parentTraceId = this.traces?.captureParentTraceId()
const runWorker = () => this.run(live, args)
const observedRun = this.traces
  ? this.traces.runRoot(
      {
        operationKind: 'worker',
        component: 'worker-pool',
        summary: 'Run Worker',
        workerId,
        sessionId,
        spaceId: args.spaceId,
        ...(parentTraceId ? { parentTraceId } : {}),
      },
      runWorker,
    )
  : runWorker()
void observedRun.catch((error: unknown) => {
  this.settle(live, { fallbackReason: `Worker run failed: ${errorText(error)}` })
})
```

- [ ] **Step 4: Wrap external ingestion and notification delivery**

Run each accepted queue decision/handoff in an external-event root. The HTTP route root may parent
the first delivery; boot recovery starts an unparented root. In `NotificationCenter`, record the
badge/push decision under the current Trace, then wrap each outbox delivery pass in a notification
root. Store endpoint IDs only as irreversible hashes; never record endpoint URLs or payload bodies.

Rename `EventIngestion.decideAndDeliver`'s current implementation to `decideAndDeliverBody` and
make the original method the wrapper below. Extract the body of `NotificationCenter`'s current
`for (const row of due)` loop into `deliverOutboxRow(row, subscriptionsByEndpoint)` so the existing
single-flight and retry boundaries remain outside the per-row Trace root.

```ts
const decideAndDeliver = () => this.decideAndDeliverBody(queueId, source)
return this.traces
  ? this.traces.runRoot(
      {
        operationKind: 'external-event',
        component: 'event-ingestion',
        summary: 'Process external event',
        externalId: String(queueId),
        details: {
          family: 'delivery',
          deliveryId: String(queueId),
          channel: source.adapter,
          outcome: 'queued',
        },
      },
      decideAndDeliver,
    )
  : decideAndDeliver()

this.traces?.recordInstantStep({
  operationKind: 'notification-decision',
  component: 'notification-center',
  summary: 'Choose notification delivery',
  details: {
    family: 'delivery',
    deliveryId: String(outbox.id),
    channel: decision.channel,
    outcome: 'queued',
    ...(decision.endpoint
      ? { endpointHash: createHash('sha256').update(decision.endpoint).digest('hex') }
      : {}),
  },
})
const deliverOutbox = () => this.deliverOutboxRow(outbox)
await (this.traces
  ? this.traces.runRoot(
      {
        operationKind: 'notification',
        component: 'notification-center',
        summary: 'Deliver notification',
        details: {
          family: 'delivery',
          deliveryId: String(outbox.id),
          channel: outbox.channel,
          outcome: 'queued',
        },
      },
      deliverOutbox,
    )
  : deliverOutbox())
```

- [ ] **Step 5: Record approval and update lifecycles**

In `TrustLayer.recordDecision`, record an instant approval step with effect/approval ID, tool name,
level, and outcome only. In `ApprovalSurfaceManager.resolve`, start a new approval root before
calling `trust.resolve`; annotate approve/reject/expired and terminal errors. In `UpdateManager`,
capture parent correlation from the fast mutation, start detached check/apply roots, and annotate
verified version/outcome without command output or environment.

Rename the current `applyUpdate` implementation to private `applyUpdateBody` and make
`applyUpdate` the wrapper below; apply the same wrapper/body split to `runCheck`. This prevents a
Trace wrapper from recursively calling itself.

```ts
this.traces?.recordInstantStep({
  operationKind: 'approval',
  component: 'trust-layer',
  summary: 'Record approval decision',
  details: { family: 'approval', approvalId, effectId, toolName, level, outcome },
})

return (
  this.traces?.runRoot(
    {
      operationKind: 'approval',
      component: 'approval-surface',
      summary: 'Resolve approval',
      details: {
        family: 'approval',
        approvalId,
        outcome: decision === 'approve' ? 'approved' : 'rejected',
      },
    },
    () => this.trust.resolve(approvalId, decision),
  ) ?? this.trust.resolve(approvalId, decision)
)

const parentTraceId = this.traces?.captureParentTraceId()
const apply = () => this.applyUpdateBody()
return this.traces
  ? this.traces.runRoot(
      {
        operationKind: 'update',
        component: 'update-manager',
        summary: 'Apply verified update',
        ...(parentTraceId ? { parentTraceId } : {}),
        details: { family: 'lifecycle', phase: 'update-apply' },
      },
      apply,
    )
  : apply()
```

- [ ] **Step 6: Wire the shared recorder in `server.ts`**

Pass `diagnostics.traces` into every production constructor. Ensure close hooks stop these producers
before `diagnostics.close()` runs. Keep existing mock and test constructors valid by making the
option optional.

```ts
const scheduler = new Scheduler({ ...schedulerOptions, traces: diagnostics.traces })
const workerPool = new WorkerPool({ ...workerOptions, traces: diagnostics.traces })
const ingestion = new EventIngestion({ ...ingestionOptions, traces: diagnostics.traces })
const notifications = new NotificationCenter({ ...notificationOptions, traces: diagnostics.traces })
const trust = new TrustLayer({ ...trustOptions, traces: diagnostics.traces })
const approvals = new ApprovalSurfaceManager({ ...approvalOptions, traces: diagnostics.traces })
const updates = new UpdateManager({ ...updateOptions, traces: diagnostics.traces })
```

- [ ] **Step 7: Run subsystem and full daemon tests**

Run: `pnpm --filter @veduta/daemon test`

Expected: PASS.

- [ ] **Step 8: Commit background instrumentation**

```bash
git add packages/daemon/src/scheduler.ts packages/daemon/src/scheduler.test.ts packages/daemon/src/worker.ts packages/daemon/src/worker.test.ts packages/daemon/src/event-ingestion.ts packages/daemon/src/event-ingestion.test.ts packages/daemon/src/notification-center.ts packages/daemon/src/notification-center.test.ts packages/daemon/src/approval-surface.ts packages/daemon/src/approval-surface.test.ts packages/daemon/src/trust-layer.ts packages/daemon/src/trust-layer.test.ts packages/daemon/src/update-manager.ts packages/daemon/src/update-manager.test.ts packages/daemon/src/server.ts
git commit -m "feat(daemon): trace durable background work (issue #50)"
```

### Task 13: Add the validated PWA diagnostic client and pure state

**Files:**

- Create: `packages/pwa/src/trace-api.ts`
- Create: `packages/pwa/src/trace-api.test.ts`
- Create: `packages/pwa/src/trace-console-state.ts`
- Create: `packages/pwa/src/trace-console-state.test.ts`
- Create: `packages/pwa/src/trace-export.ts`
- Create: `packages/pwa/src/trace-export.test.ts`
- Modify: `packages/pwa/src/api.ts:578-582`
- Modify: `packages/pwa/src/api.test.ts`

**Interfaces:**

- Produces `fetchTraceEvents`, `fetchTraceDetail`, `fetchRuntimeLogSegments`,
  `fetchRuntimeLogSegment`, and `connectTraceStream`.
- Consumes an exported `getJson(path, token)` from `api.ts`, preserving the PWA's existing
  `ApiResponseError` and Bearer-session behavior instead of duplicating it.
- Produces `TraceStreamConnection { subscribe(view, cursor?): void; close(): void }`.
- `TraceStreamOptions` is `{ token?: string; view: DiagnosticView; cursor?: string;
onMessage(message: TraceSocketServerMessage): void; onOpen(): void; onClose(): void }`;
  `connectTraceStream(options)` returns `TraceStreamConnection` and is the only function in the PWA
  that constructs `/ws/trace`.
- Produces pure state functions `initialTraceConsoleState`, `applyTraceSocketMessage`,
  `setTraceView`, `setRealtime`, `pauseFollowing`, `resumeFollowing`, `appendActivityPage`, and
  `appendRuntimeSegment`.
- `TraceConsoleState` owns `{ view, realtime, connectionState, following, unseenCount,
backendState, rows, recordIds, activityCursor?, runtimeCursor? }`; `rows` is a discriminated union
  of Activity, Runtime, and gap rows, and `recordIds` is an in-memory `Set<string>`.
- Produces `serializeLoadedDiagnostics(view, records): string` and
  `downloadLoadedDiagnostics(view, records, document): void`; both protocol-validate records and
  accept only the current in-memory Activity or Runtime array.

- [ ] **Step 1: Write failing client/state tests**

Mock `fetch` and `WebSocket`. Assert all REST responses are protocol-parsed, query values are
encoded with `URLSearchParams`, `401` propagates as `ApiResponseError`, the socket URL is exactly
the current origin's `/ws/trace` with no credential, token appears only in the first `hello`, view switching sends one
`subscribe`, and no socket is constructed merely by creating initial state.

Assert reducer transitions for historical-only, LIVE, PAUSED, RECONNECTING, OFFLINE, DEGRADED,
INDEXING, unseen counts, gap rows, dedupe by record ID, and active-view-only records.
Add a static assertion that the existing service worker continues to return before handling every
`/api/*` and `/ws/*` request, so diagnostic responses cannot enter its cache.

```ts
it('validates retained pages and keeps credentials out of the URL', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], gaps: [], backendState: 'READY' }), {
        status: 200,
      }),
    ),
  )
  await expect(fetchTraceEvents({ limit: 100 }, 'vdt_session')).resolves.toEqual(
    expect.objectContaining({ items: [] }),
  )
  expect(fetch).toHaveBeenCalledWith(
    '/api/trace-events?limit=100',
    expect.objectContaining({ headers: expect.any(Headers) }),
  )
})

it('constructs no socket until explicit realtime connection', () => {
  const WebSocketMock = vi.fn(() => ({ addEventListener: vi.fn(), send: vi.fn(), close: vi.fn() }))
  vi.stubGlobal('WebSocket', WebSocketMock)
  initialTraceConsoleState()
  expect(WebSocketMock).not.toHaveBeenCalled()
  connectTraceStream({
    token: 'vdt_session',
    view: 'activity',
    onMessage: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
  })
  expect(WebSocketMock).toHaveBeenCalledWith(expect.stringMatching(/^wss?:\/\/[^?]+\/ws\/trace$/))
})

it('exports only protocol-validated loaded records', () => {
  const record = RuntimeLogRecordSchema.parse({
    schemaVersion: 1,
    recordId: '44444444-4444-4444-8444-444444444444',
    at: '2026-08-10T12:00:01.000Z',
    level: 'ERROR',
    component: 'provider',
    message: '[redacted]',
  })
  expect(JSON.parse(serializeLoadedDiagnostics('runtime', [record]))).toEqual({
    schemaVersion: 1,
    view: 'runtime',
    records: [record],
  })
  expect(() => serializeLoadedDiagnostics('runtime', [{ rawSecret: 'not a record' }])).toThrow()
})

it('leaves diagnostic requests outside the service-worker cache', async () => {
  const source = await readFile(new URL('../public/service-worker.js', import.meta.url), 'utf8')
  expect(source).toContain("url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')")
})
```

- [ ] **Step 2: Run focused PWA tests and verify failure**

Run: `pnpm --filter @veduta/pwa exec vitest run src/trace-api.test.ts src/trace-console-state.test.ts src/trace-export.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement validated REST helpers**

```ts
export async function fetchTraceEvents(
  query: TraceSearchQuery,
  token?: string,
): Promise<TraceEventsPage> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) search.set(key, String(value))
  return TraceEventsPageSchema.parse(await getJson(`/api/trace-events?${search}`, token))
}
```

Export the existing `getJson` helper from `api.ts` without changing its body, add one `api.test.ts`
assertion that its non-2xx path still throws `ApiResponseError`, and import it in `trace-api.ts`.
Parse each diagnostic result with its exact protocol schema.

- [ ] **Step 4: Implement opt-in socket and pure state transitions**

Construct `WebSocket` only inside `connectTraceStream`. On open send `hello`; parse every incoming
frame with `TraceSocketServerMessageSchema`; expose callbacks for message/close/open. `subscribe`
sends the currently selected view and its last cursor.

Keep all loaded records in React memory only. State functions reject records for the inactive view,
convert Gateway gaps into visible rows, and increment `unseenCount` while follow mode is paused.

```ts
export function connectTraceStream(options: TraceStreamOptions): TraceStreamConnection {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(`${protocol}//${location.host}/ws/trace`)
  let opened = false
  let subscription = { view: options.view, cursor: options.cursor }
  socket.addEventListener('open', () => {
    opened = true
    socket.send(
      JSON.stringify({
        type: 'hello',
        ...(options.token ? { token: options.token } : {}),
        view: subscription.view,
        ...(subscription.cursor ? { cursor: subscription.cursor } : {}),
      }),
    )
    options.onOpen()
  })
  socket.addEventListener('message', (event) =>
    options.onMessage(TraceSocketServerMessageSchema.parse(JSON.parse(String(event.data)))),
  )
  socket.addEventListener('close', () => {
    opened = false
    options.onClose()
  })
  return {
    subscribe: (view, cursor) => {
      subscription = { view, cursor }
      if (opened) {
        socket.send(JSON.stringify({ type: 'subscribe', view, ...(cursor ? { cursor } : {}) }))
      }
    },
    close: () => socket.close(),
  }
}

export function applyTraceSocketMessage(
  state: TraceConsoleState,
  message: TraceSocketServerMessage,
): TraceConsoleState {
  const messageView =
    message.type === 'gap' || message.type === 'state' ? message.view : message.type
  if (messageView !== state.view) return state
  if (message.type === 'gap')
    return { ...state, rows: [...state.rows, { kind: 'gap', gap: message.gap }] }
  if (message.type === 'state') return { ...state, backendState: message.state }
  const id = `${message.type}:${
    message.type === 'activity' ? message.record.eventId : message.record.recordId
  }`
  if (state.recordIds.has(id)) return state
  const recordIds = new Set(state.recordIds).add(id)
  return {
    ...state,
    recordIds,
    rows: [...state.rows, { kind: message.type, cursor: message.cursor, record: message.record }],
    unseenCount: state.following ? state.unseenCount : state.unseenCount + 1,
  }
}

export function serializeLoadedDiagnostics(view: DiagnosticView, records: unknown[]): string {
  const schema = view === 'activity' ? z.array(TraceEventSchema) : z.array(RuntimeLogRecordSchema)
  return JSON.stringify({ schemaVersion: 1, view, records: schema.parse(records) }, null, 2)
}

export function downloadLoadedDiagnostics(
  view: DiagnosticView,
  records: unknown[],
  ownerDocument: Document,
): void {
  const url = URL.createObjectURL(
    new Blob([serializeLoadedDiagnostics(view, records)], { type: 'application/json' }),
  )
  try {
    const anchor = ownerDocument.createElement('a')
    anchor.href = url
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    anchor.download = `veduta-${view}-${timestamp}.json`
    anchor.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}
```

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @veduta/pwa exec vitest run src/trace-api.test.ts src/trace-console-state.test.ts src/trace-export.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit PWA transport/state**

```bash
git add packages/pwa/src/api.ts packages/pwa/src/api.test.ts packages/pwa/src/trace-api.ts packages/pwa/src/trace-api.test.ts packages/pwa/src/trace-console-state.ts packages/pwa/src/trace-console-state.test.ts packages/pwa/src/trace-export.ts packages/pwa/src/trace-export.test.ts
git commit -m "feat(pwa): add trace console client state (issue #50)"
```

### Task 14: Build the hidden Activity console and inspector

**Files:**

- Create: `packages/pwa/src/trace-status.tsx`
- Create: `packages/pwa/src/trace-status.test.tsx`
- Create: `packages/pwa/src/trace-activity.tsx`
- Create: `packages/pwa/src/trace-activity.test.tsx`
- Create: `packages/pwa/src/trace-console.tsx`
- Create: `packages/pwa/src/trace-console.test.tsx`
- Create: `packages/pwa/src/trace-console.css`
- Modify: `packages/pwa/src/app.tsx:66-111,263-394,580-660`
- Modify: `packages/pwa/src/app.test.tsx`

**Interfaces:**

- `TraceStatus` renders exactly one accessible marker: blue animated ring RUNNING, green dot
  COMPLETED, red dot ERROR; reduced motion disables the animation.
- `TraceStatusValue = TraceSummary['status']`.
- `TraceActivity` accepts loaded page, selected detail, filters, load/select/copy/download callbacks.
- `TraceConsole` accepts the auth token and owns in-memory diagnostic state.

- [ ] **Step 1: Write failing route and Activity component tests**

Assert direct `/app/trace` after auth renders `Activity`; ordinary Home contains no Trace link or
button; the hidden route does not call `connectGateway`; an invalid VPS-profile session returns to
`AuthGate`; required onboarding still renders the wizard.

For Activity assert search plus time/Space/session/component/status/traceId controls, dense rows,
loaded-data volume bars, one status marker per row, exactly one marker in the inspector header,
conditional details with no empty cost/reasoning panel, unknown family visible in text, progressive
detail loading, copy, current-loaded-record download, and mobile detail close behavior.

```tsx
it('renders the authenticated hidden route without Home navigation or chat socket', async () => {
  window.history.pushState({}, '', '/app/trace')
  render(<App />)
  expect(await screen.findByRole('heading', { name: 'Activity' })).toBeVisible()
  expect(connectGateway).not.toHaveBeenCalled()
  expect(screen.queryByRole('link', { name: /trace/i })).not.toBeInTheDocument()
})

it('shows one status marker and only fields present on the selected Trace', async () => {
  render(
    <TraceActivity
      page={TRACE_PAGE}
      selected={TRACE_DETAIL_WITHOUT_USAGE}
      filters={EMPTY_FILTERS}
      onFiltersChange={vi.fn()}
      onLoadMore={vi.fn()}
      onSelect={vi.fn()}
      onCopy={vi.fn()}
      onDownload={vi.fn()}
    />,
  )
  expect(screen.getAllByRole('img', { name: 'Error' })).toHaveLength(2)
  expect(screen.queryByText(/cost/i)).not.toBeInTheDocument()
  expect(screen.queryByText(/reasoning/i)).not.toBeInTheDocument()
  expect(screen.getByText('future-family')).toBeVisible()
})
```

- [ ] **Step 2: Run focused PWA tests and verify failure**

Run: `pnpm --filter @veduta/pwa exec vitest run src/trace-status.test.tsx src/trace-activity.test.tsx src/trace-console.test.tsx src/app.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Add the status marker and Activity view**

```tsx
export function TraceStatus({ status }: { status: TraceStatusValue }) {
  return (
    <span
      className={`trace-status trace-status-${status.toLowerCase()}`}
      role="img"
      aria-label={status === 'RUNNING' ? 'Running' : status === 'ERROR' ? 'Error' : 'Completed'}
    />
  )
}
```

Render the toolbar as native labeled controls and a submit/reset pair. Compute at most 24 volume
buckets from the loaded summaries only. Rows are buttons with time, marker, Space, component,
summary, and duration. Render selected events grouped by `stepId`; show detail fields only when
present. Render JSON through `<pre>{JSON.stringify(value, null, 2)}</pre>`, never HTML injection.

- [ ] **Step 4: Add the hidden route without opening Home's socket**

Derive `const traceRoute = location.pathname === '/app/trace'`. In the auth-status effect, skip
`fetchSpaces` and `startGateway` for this route while still running auth and onboarding gates.
After those gates, render `<TraceConsole token={authToken} />` before the Model connections/Home
branches. Add no navigation element that points to `/app/trace`.

```tsx
const traceRoute = window.location.pathname === '/app/trace'

fetchAuthStatus()
  .then((status) => {
    setAuthMode(status.mode)
    setBootstrapRequired(status.bootstrapRequired)
    setPasskeyRegistered(status.passkeyRegistered)
    if (status.mode === 'production' && !authToken) return undefined
    if (traceRoute) return undefined
    return fetchSpaces(authToken)
  })
  .then((snapshot) => {
    if (!snapshot || traceRoute) return
    replaceSpaces(snapshot.spaces, snapshot.surfaceCursor)
    startGateway()
  })

// Keep the current AuthGate and OnboardingWizard branches immediately above this branch.
if (traceRoute) return <TraceConsole token={authToken} />
```

- [ ] **Step 5: Style the approved dense console skeleton**

Use existing CSS variables from `app.css`. Desktop uses full-width list plus a minimal selected
inspector; no permanent empty panel or detail tabs. Give the status column enough width for the
blue ring and dots. At `max-width: 720px`, make the list full width and the inspector a fixed
full-screen layer. Add `prefers-reduced-motion` for the RUNNING ring.

```css
.trace-activity-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(20rem, 34rem);
}
.trace-status-cell {
  inline-size: 6.5rem;
}
.trace-status-running {
  animation: trace-spin 1s linear infinite;
  border: 2px solid var(--accent);
}
@media (max-width: 720px) {
  .trace-activity-layout {
    display: block;
  }
  .trace-inspector {
    position: fixed;
    inset: 0;
    z-index: 20;
    overflow: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .trace-status-running {
    animation: none;
  }
}
```

- [ ] **Step 6: Run focused tests**

Run: `pnpm --filter @veduta/pwa exec vitest run src/trace-status.test.tsx src/trace-activity.test.tsx src/trace-console.test.tsx src/app.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit Activity UI**

```bash
git add packages/pwa/src/trace-status.tsx packages/pwa/src/trace-status.test.tsx packages/pwa/src/trace-activity.tsx packages/pwa/src/trace-activity.test.tsx packages/pwa/src/trace-console.tsx packages/pwa/src/trace-console.test.tsx packages/pwa/src/trace-console.css packages/pwa/src/app.tsx packages/pwa/src/app.test.tsx
git commit -m "feat(pwa): add hidden activity console (issue #50)"
```

### Task 15: Add Runtime logs, shared realtime control, and follow behavior

**Files:**

- Create: `packages/pwa/src/trace-runtime.tsx`
- Create: `packages/pwa/src/trace-runtime.test.tsx`
- Modify: `packages/pwa/src/trace-console.tsx`
- Modify: `packages/pwa/src/trace-console.test.tsx`
- Modify: `packages/pwa/src/trace-console.css`

**Interfaces:**

- `TraceRuntime` accepts retained segments/records, selected row, follow/unseen state, and callbacks.
- `TraceConsole` owns exactly one unchecked `Real-time logs` checkbox and at most one
  `TraceStreamConnection`; switching view replaces its subscription.

- [ ] **Step 1: Write failing Runtime/realtime component tests**

Assert:

- Activity and Runtime logs are the only view tabs;
- the realtime checkbox starts unchecked and no WebSocket is constructed;
- checking opens one socket for the active view; switching sends one replacement subscription;
- unchecking closes it without discarding retained records or viewport state;
- all DEBUG/INFO/WARN/ERROR rows stay visible with no filter controls;
- newest segment loads first and each action loads exactly one older segment;
- scrolling more than 48 px from bottom or selecting a row pauses follow;
- live records while paused increment unseen count without moving the viewport;
- Resume clears unseen and scrolls to bottom;
- connection/gap/rotation rows and HISTORICAL, LIVE, PAUSED, RECONNECTING, OFFLINE, DEGRADED, and
  INDEXING labels are visible;
- copy and download contain only the selected/current loaded redacted data.

```tsx
it('opens one opt-in stream and replaces its view subscription', async () => {
  render(<TraceConsole token="vdt_session" />)
  expect(connectTraceStream).not.toHaveBeenCalled()
  await user.click(screen.getByRole('checkbox', { name: 'Real-time logs' }))
  expect(connectTraceStream).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('tab', { name: 'Runtime logs' }))
  expect(connection.subscribe).toHaveBeenLastCalledWith('runtime', expect.anything())
  expect(connectTraceStream).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole('checkbox', { name: 'Real-time logs' }))
  expect(connection.close).toHaveBeenCalledTimes(1)
})

it('pauses follow without hiding any Runtime level', async () => {
  render(<TraceRuntime {...RUNTIME_PROPS} records={ALL_LEVEL_RECORDS} />)
  for (const level of ['DEBUG', 'INFO', 'WARN', 'ERROR']) {
    expect(screen.getByText(level)).toBeVisible()
  }
  fireEvent.scroll(screen.getByTestId('runtime-scroll'), {
    target: {
      scrollHeight: 1_000,
      scrollTop: 200,
      clientHeight: 400,
    },
  })
  expect(RUNTIME_PROPS.onPauseFollowing).toHaveBeenCalled()
})
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @veduta/pwa exec vitest run src/trace-runtime.test.tsx src/trace-console.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement the terminal-like Runtime view**

Render rows as text with timestamp, level, component, message, and a clickable correlated
`traceId` that switches to Activity with that filter. Keep all four levels visible. Load the newest
segment after inventory, prepend one older segment per request while preserving scroll offset, and
keep live records separate from immutable retained segment arrays.

Use a scroll container ref:

```ts
const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
if (distanceFromBottom > 48) onPauseFollowing()
```

Selecting a row also pauses. Resume calls `scrollTo({ top: scrollHeight })` after state commit.

- [ ] **Step 4: Own one opt-in realtime connection in the parent**

On checkbox enable, call `connectTraceStream` with current view/cursor. On view change call
`connection.subscribe(nextView, cursorFor(nextView))`; do not open a second connection. On disable
or unmount, close and clear it. Reconnect with capped exponential delays of 1, 2, 4, 8, 16, and 30
seconds only while the checkbox remains checked.

```tsx
const connectionRef = useRef<TraceStreamConnection | undefined>(undefined)
const retryRef = useRef(0)
const viewRef = useRef(view)
const stateRef = useRef(state)
const messageHandlerRef = useRef(handleLiveMessage)
viewRef.current = view
stateRef.current = state
messageHandlerRef.current = handleLiveMessage

useEffect(() => {
  if (!realtime) return
  let cancelled = false
  let retryTimer: number | undefined
  const connect = () => {
    if (cancelled) return
    connectionRef.current = connectTraceStream({
      token,
      view: viewRef.current,
      cursor: cursorFor(stateRef.current, viewRef.current),
      onMessage: (message) => messageHandlerRef.current(message),
      onOpen: () => {
        retryRef.current = 0
        setConnectionState('LIVE')
      },
      onClose: () => {
        if (cancelled) return
        setConnectionState('RECONNECTING')
        const delays = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]
        const delay = delays[Math.min(retryRef.current, delays.length - 1)]!
        retryRef.current += 1
        retryTimer = window.setTimeout(connect, delay)
      },
    })
  }
  connect()
  return () => {
    cancelled = true
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    connectionRef.current?.close()
    connectionRef.current = undefined
  }
}, [realtime, token])

useEffect(() => {
  if (realtime) connectionRef.current?.subscribe(view, cursorFor(stateRef.current, view))
}, [realtime, view])
```

- [ ] **Step 5: Complete responsive Runtime styling**

Use a monospace stack for log rows, wrap long values without horizontal page overflow, preserve a
stable level/component column on desktop, and collapse metadata onto two lines on mobile. Gap and
state rows use text plus color so color is never the only signal.

```css
.trace-runtime-row {
  display: grid;
  grid-template-columns: 12rem 4rem 12rem minmax(0, 1fr);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.trace-runtime-message {
  min-inline-size: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.trace-gap::before {
  content: 'Data gap: ';
  font-weight: 700;
}
@media (max-width: 720px) {
  .trace-runtime-row {
    grid-template-columns: 4rem minmax(0, 1fr);
  }
  .trace-runtime-time,
  .trace-runtime-component {
    grid-column: 1 / -1;
  }
}
```

- [ ] **Step 6: Run the complete PWA test suite**

Run: `pnpm --filter @veduta/pwa test`

Expected: PASS.

- [ ] **Step 7: Commit Runtime/realtime UI**

```bash
git add packages/pwa/src/trace-runtime.tsx packages/pwa/src/trace-runtime.test.tsx packages/pwa/src/trace-console.tsx packages/pwa/src/trace-console.test.tsx packages/pwa/src/trace-console.css
git commit -m "feat(pwa): add realtime runtime logs (issue #50)"
```

### Task 16: Prove cross-sink safety, restart retention, and hard-down recovery

**Files:**

- Modify: `packages/daemon/src/security-hardening.test.ts`
- Modify: `packages/daemon/src/server.test.ts`
- Modify: `packages/pwa/src/trace-console.test.tsx`
- Modify: `packages/e2e/tests/local-vps.spec.ts`
- Create: `docs/diagnostics.md`
- Modify: `deploy/README.md`
- Modify: `deploy/local-vps.md`
- Modify: `issues/050-internal-trace-console.md` only to check acceptance boxes backed by evidence.

**Interfaces:**

- Consumes the completed diagnostic system; introduces no new production API.

- [ ] **Step 1: Add one cross-sink sentinel test**

Register distinct fake API key, OAuth refresh token, Authorization header, session token, bootstrap
code, and nested cookie values. Drive them through Runtime messages, Trace summary/details, tool
input/result, error/stack, REST, WebSocket, copy serializer, and download serializer. Sweep Activity
JSONL, Runtime JSONL, the Trace SQLite database and WAL/SHM rows, injected journal lines, REST
bodies, WS frames, and browser-export text. Assert every sentinel is absent and truncation metadata
describes the redacted serialization.

```ts
it('keeps registered and structural secrets out of every diagnostic sink', async () => {
  const sentinels = [
    'sk-test-abcdefghijklmnop',
    '1//refresh-abcdefghijklmnop',
    'vdt_session-abcdefghijklmnop',
    'bootstrap-abcdefghijklmnop',
    'cookie-abcdefghijklmnop',
  ]
  for (const sentinel of sentinels) defaultRedactor.register(sentinel)
  diagnostics.runtime.error('security-test', `Bearer ${sentinels[0]}`, {
    authorization: sentinels[0],
    cookie: { value: sentinels[4] },
  })
  await diagnostics.traces
    .runRoot(
      {
        operationKind: 'chat',
        component: 'security-test',
        summary: `turn ${sentinels[2]}`,
        details: {
          family: 'tool',
          toolCallId: 'sentinel-call',
          toolName: 'sentinel',
          input: { refreshToken: sentinels[1], text: 'x'.repeat(70_000) },
        },
      },
      async () => {
        throw new Error(`bootstrap ${sentinels[3]}`)
      },
    )
    .catch(() => undefined)
  await diagnostics.traces.flush()

  const rest = await app.inject({ method: 'GET', url: '/api/trace-events', headers: AUTH_HEADERS })
  const sinkText = [
    journal.join('\n'),
    rest.body,
    ...readFilesRecursively(join(dataDir, 'diagnostics')),
    JSON.stringify(traceSocketFrames),
  ].join('\n')
  for (const sentinel of sentinels) expect(sinkText).not.toContain(sentinel)
  expect(sinkText).not.toMatch(/authorization|refreshToken|cookie/i)
  expect(sinkText).toContain('originalBytes')
})

function readFilesRecursively(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? readFilesRecursively(path) : [readFileSync(path).toString('utf8')]
  })
}
```

In `trace-export.test.ts`, pass protocol-parsed records containing `[redacted]` values into
`serializeLoadedDiagnostics`, intercept the Blob passed to `URL.createObjectURL`, and assert copy
and download contain exactly those validated records and no extra source value. Combined with the
Gateway sink sweep above, this proves the browser export cannot reintroduce a removed sentinel.
Do not add a second redactor in the browser.

- [ ] **Step 2: Add the end-to-end retained Trace journey**

Extend the existing serial Local VPS test after its real chat/Surface mutation:

1. navigate directly to `/app/trace` with the authenticated session;
2. find the chat root and open it;
3. assert model, tool, Surface, and Event log steps share one `traceId`;
4. assert the realtime checkbox is off, enable it, and observe one new Runtime record;
5. stop and restart the same stack/base directory;
6. sign in and verify the retained Trace and Runtime segment remain readable.

Use the existing WebAuthn virtual authenticator and restart helpers; do not create a second stack
inside the same test.

```ts
await test.step('locate the retained chat Trace', async () => {
  await page.goto(`${stack!.origin}/app/trace`)
  await expect(page.getByRole('heading', { name: 'Activity' })).toBeVisible()
  const chatRow = page.getByRole('button', { name: /Chat turn/ }).first()
  await chatRow.click()
  const traceId = await chatRow.getAttribute('data-trace-id')
  for (const label of ['model', 'tool', 'Surface', 'Event log']) {
    await expect(page.getByText(label, { exact: false })).toBeVisible()
  }
  await expect(page.locator(`[data-trace-id="${traceId}"]`)).not.toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: 'Real-time logs' })).not.toBeChecked()
})

await test.step('retain diagnostics across the existing restart leg', async () => {
  await page.goto(`${stack!.origin}/app/trace`)
  await expect(page.getByRole('button', { name: /Chat turn/ }).first()).toBeVisible()
  await page.getByRole('tab', { name: 'Runtime logs' }).click()
  await expect(page.getByText(/Gateway listening/).first()).toBeVisible()
})
```

- [ ] **Step 3: Run security and Local VPS evidence tests**

Run:

```bash
pnpm --filter @veduta/daemon exec vitest run src/security-hardening.test.ts src/server.test.ts
pnpm --filter @veduta/pwa exec vitest run src/trace-console.test.tsx
pnpm --filter @veduta/e2e test:e2e -- local-vps.spec.ts
```

Expected: PASS.

- [ ] **Step 4: Write the exact diagnostics runbook**

Document normal `/app/trace` access and these hard-down commands with the final segment names:

```bash
sudo journalctl -u veduta.service -n 200 --no-pager
sudo journalctl -u veduta.service -f
sudo find /var/lib/veduta/.veduta/diagnostics/runtime -maxdepth 1 -type f -name 'seg-*.jsonl' -print
sudo sh -c 'latest=$(ls -1t /var/lib/veduta/.veduta/diagnostics/runtime/seg-*.jsonl 2>/dev/null | head -n 1); test -n "$latest" && tail -n 200 "$latest"'

find "$HOME/.veduta-local-vps/data/diagnostics/runtime" -maxdepth 1 -type f -name 'seg-*.jsonl' -print
sh -c 'latest=$(ls -1t "$HOME"/.veduta-local-vps/data/diagnostics/runtime/seg-*.jsonl 2>/dev/null | head -n 1); test -n "$latest" && tail -n 200 "$latest"'
```

Explain that each tail command selects the most recently modified retained segment. State
explicitly that `/app/trace` cannot work while the Gateway is down and that there is no recovery
sidecar or second viewer. For the Local VPS profile, process output remains in the terminal that
started `pnpm local-vps`; do not invent a systemd unit name.

Update production pairing repair advice to rerun the guided installer/pairing handoff rather than
grepping a bootstrap code from `journald`.

- [ ] **Step 5: Run the repository-required validation**

Run:

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

Expected: every command exits 0.

- [ ] **Step 6: Check issue acceptance boxes supported by the tests and docs**

Mark each criterion in `issues/050-internal-trace-console.md` only after naming its passing focused
or end-to-end evidence in the commit body or PR description. Leave no criterion checked solely
because code exists.

```markdown
- [x] **Locate the failure:** `trace-console.test.tsx` and the Local VPS Trace step.
- [x] **Safe durable output:** `security-hardening.test.ts` cross-sink sentinel sweep.
- [x] **Restart and hard-down evidence:** Local VPS restart step and `docs/diagnostics.md`.
```

Apply this evidence rule to every acceptance checkbox, not only the three examples above.

- [ ] **Step 7: Commit final evidence and operations documentation**

```bash
git add packages/daemon/src/security-hardening.test.ts packages/daemon/src/server.test.ts packages/pwa/src/trace-console.test.tsx packages/e2e/tests/local-vps.spec.ts docs/diagnostics.md deploy/README.md deploy/local-vps.md issues/050-internal-trace-console.md
git commit -m "test: verify internal trace console (issue #50)"
```

---

## Final Review Checklist

- Every approved operation family has a root or meaningful step; token deltas and ordinary
  functions do not create Activity noise.
- One completed chat fixture demonstrates model, tool, Surface, and Event log correlation under one
  `traceId`; retry/failover failures remain visible.
- Diagnostic failure, queue saturation, corrupt index, partial JSONL, rotated cursors, and slow
  browsers fail open with visible gaps.
- No diagnostic response, frame, file, index row, journal line, copy, or download contains the
  security sentinels.
- Activity and Runtime retention/permissions are deterministic and tested with small injected
  limits.
- REST and WebSocket are session-protected, same-origin, bounded, and no-store; revocation closes
  the Trace socket.
- `/app/trace` is absent from navigation, uses no Home chat socket, and opens no Trace socket until
  the unchecked realtime box is enabled.
- Desktop and mobile render one accessible status marker, conditional detail only, all Runtime
  levels, explicit state/gap rows, and preserved follow position.
- Restart evidence and exact SSH recovery commands exist; no second diagnostic service exists.
- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and the focused Local
  VPS Playwright journey pass.
