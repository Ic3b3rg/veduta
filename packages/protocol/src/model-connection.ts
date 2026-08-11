import { z } from 'zod'

/**
 * The Model connection authorization lifecycle (issue #47, ADR-0014): every
 * adapter — BYOK, Claude subscription, or ChatGPT/Codex — exposes the same
 * nine states so the PWA renders one set of recovery affordances instead of
 * per-provider flows.
 *
 * - `available` — the method can be used to create a connection; nothing has
 *   been authorized yet.
 * - `authorizing` — a `POST /authorize` call is in flight (an API-key test,
 *   or the start of a device-code login).
 * - `waiting-for-user` — a device-code login was started; the PWA is
 *   showing the verification URL and user code while the provider waits for
 *   the account holder to complete it out of band.
 * - `verifying` — authorization succeeded and a live inference probe
 *   (`probeModel`) is confirming the connection actually works before it is
 *   marked usable.
 * - `connected` — the connection passed verification and is usable for
 *   inference and, once selected, for routing.
 * - `expired` — a previously connected credential stopped working and an
 *   automatic refresh has not (yet) recovered it.
 * - `reconnecting` — an automatic refresh of an `expired` connection is in
 *   flight.
 * - `failed` — authorization, verification, or a live call failed in a way
 *   that requires the user to act (a bad key, an interrupted daemon
 *   restart, a device code that expired before it was entered).
 * - `revoked` — the provider or the user ended the connection; it is never
 *   used for inference again without a fresh authorization.
 */
export const ConnectionLifecycleStateSchema = z.enum([
  'available',
  'authorizing',
  'waiting-for-user',
  'verifying',
  'connected',
  'expired',
  'reconnecting',
  'failed',
  'revoked',
])

/** The five connection methods issue #47 ships: three BYOK providers, ChatGPT/Codex, and the (permanently unavailable) Claude subscription. */
export const ModelConnectionMethodIdSchema = z.enum([
  'anthropic-api-key',
  'openai-api-key',
  'openrouter-api-key',
  'chatgpt-codex',
  'claude-subscription',
])

/**
 * Every new connection is identified by a fresh `crypto.randomUUID()`. The
 * three bare provider names are reserved: they are never chosen by a user
 * or the API, only created by the BYOK-to-Model-connection migration
 * (`docs/adr/0014-subscription-inference-boundary.md` amendment) so a
 * pre-existing `secret://vault/anthropic` keeps resolving under the same
 * name it always had.
 */
export const ModelConnectionIdSchema = z.union([
  z.string().uuid(),
  z.enum(['anthropic', 'openai', 'openrouter']),
])

/** One entry in a connection's fetched model catalog. `routable: false` marks a model this build cannot route to, shown disabled rather than hidden (issue #47: "show the full returned catalog without a curated subset"). */
export const ModelCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    routable: z.boolean(),
  })
  .strict()

/**
 * A device-code login in progress (`waiting-for-user`). Held in the
 * Gateway's in-memory challenge map only — never persisted to
 * `connections.json` — so a daemon restart cannot resurrect a stale login
 * (ADR-0014 amendment); the record itself moves to `failed` on boot instead.
 * `expirySource` is `'provider'` when the pinned protocol reported its own
 * expiry, or `'veduta-default'` when Veduta imposed its own cap — the PWA
 * must never claim a provider guarantee Veduta invented.
 */
export const DeviceChallengeSchema = z
  .object({
    loginId: z.string().min(1),
    verificationUrl: z.string().min(1),
    userCode: z.string().min(1),
    expiresAt: z.string().min(1),
    expirySource: z.enum(['provider', 'veduta-default']),
  })
  .strict()

/** What an adapter can and cannot do, surfaced to the PWA so it never hardcodes per-provider behavior. */
export const ModelConnectionCapabilitiesSchema = z
  .object({
    authorization: z.enum(['api-key', 'device-code', 'none']),
    refresh: z.enum(['automatic', 'static']),
    revocation: z.enum(['provider', 'local-only']),
    /** Temporary compatibility capability: whether Veduta's own ToolDefs may be offered to a turn on this connection (issue #73; removed with this gate in issue #79). */
    vedutaTools: z.boolean(),
    /** Metered spend is possible on this method (BYOK, or a subscription with usage credits). */
    metered: z.boolean(),
  })
  .strict()

/** One connection method as offered by the registry: display metadata, capabilities, and availability (e.g. the Claude gate, or a missing Codex binary) — all data, never hardcoded in the PWA. */
export const ModelConnectionMethodSchema = z
  .object({
    id: ModelConnectionMethodIdSchema,
    provider: z.string().min(1),
    providerDisplayName: z.string().min(1),
    methodDisplayName: z.string().min(1),
    capabilities: ModelConnectionCapabilitiesSchema,
    available: z.boolean(),
    unavailableReason: z.string().optional(),
    docsUrl: z.string().optional(),
  })
  .strict()

/**
 * The wire shape of one Model connection, as served to and posted by the
 * PWA. `.strict()` deliberately rejects any payload carrying a secret
 * reference (the daemon-side vault pointer stored in `connections.json`,
 * ADR-0014 amendment): this shape never carries a secret, on the way in or
 * out, so a bug that leaks the daemon record verbatim fails a parse instead
 * of leaking a credential.
 */
export const ModelConnectionSchema = z
  .object({
    id: ModelConnectionIdSchema,
    method: ModelConnectionMethodIdSchema,
    provider: z.string().min(1),
    label: z.string().min(1),
    state: ConnectionLifecycleStateSchema,
    stateReason: z.string().optional(),
    stateAt: z.string(),
    enabledForFallback: z.boolean(),
    createdAt: z.string(),
    selectedModelId: z.string().min(1).optional(),
    catalog: z.array(ModelCatalogEntrySchema).optional(),
    catalogFetchedAt: z.string().optional(),
    account: z
      .object({ label: z.string().min(1) })
      .strict()
      .optional(),
    /** Served from the in-memory challenge map while `state === 'waiting-for-user'`; never persisted. */
    challenge: DeviceChallengeSchema.optional(),
  })
  .strict()

/** The one visible routing control (issue #47): which connection, and which model from that connection's catalog. */
export const ModelConnectionSelectionSchema = z
  .object({
    connectionId: ModelConnectionIdSchema,
    modelId: z.string().min(1),
  })
  .strict()

/** `GET /api/model-connections` response: every offerable method, every stored connection, and the current selection (or `null` before any connection has been selected). */
export const ModelConnectionsSnapshotSchema = z
  .object({
    vaultAvailable: z.boolean(),
    mockEnabled: z.boolean(),
    mockControlAvailable: z.boolean(),
    methods: z.array(ModelConnectionMethodSchema),
    connections: z.array(ModelConnectionSchema),
    selection: ModelConnectionSelectionSchema.nullable(),
  })
  .strict()

/** `POST /api/model-connections` body: create a new connection for `method`. `apiKey` is required for the BYOK methods and absent for device-code methods (device-code authorization happens in a follow-up `POST /:id/authorize`). */
export const CreateModelConnectionRequestSchema = z
  .object({
    method: ModelConnectionMethodIdSchema,
    label: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
  })
  .strict()

/** `POST /api/model-connections/:id/authorize` body. Method-discriminated at the route: an api-key method requires `apiKey`; a device-code method requires an empty body. */
export const AuthorizeModelConnectionRequestSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
  })
  .strict()

/** `POST /api/model-connections/:id/authorize` response. `challenge` is present only when authorization started a device-code login (`state: 'waiting-for-user'`). */
export const AuthorizeModelConnectionResponseSchema = z
  .object({
    state: ConnectionLifecycleStateSchema,
    challenge: DeviceChallengeSchema.optional(),
  })
  .strict()

/** `PATCH /api/model-connections/:id` body: rename a connection, or opt it in/out of fallback routing. */
export const UpdateModelConnectionRequestSchema = z
  .object({
    label: z.string().min(1).optional(),
    enabledForFallback: z.boolean().optional(),
  })
  .strict()

/** `POST /api/model-connections/:id/verify` body: run a real inference probe against `modelId`. */
export const VerifyModelConnectionRequestSchema = z
  .object({
    modelId: z.string().min(1),
  })
  .strict()

/** `POST /api/model-connections/:id/verify` response: the probe's exact outcome, never a bare status code. */
export const VerifyModelConnectionResponseSchema = z.discriminatedUnion('result', [
  z.object({ result: z.literal('ok') }).strict(),
  z.object({ result: z.literal('failed'), reason: z.string() }).strict(),
])

/** `POST /api/model-connections/selection` body: the same shape as the stored selection (verify-then-commit, ADR-0014 amendment — never applied before a live probe succeeds). */
export const ApplyModelSelectionRequestSchema = ModelConnectionSelectionSchema

/** `POST /api/model-connections/:id/catalog` response: the full account catalog, no curated subset. */
export const ModelConnectionCatalogResponseSchema = z
  .object({
    models: z.array(ModelCatalogEntrySchema),
  })
  .strict()

/** `POST /api/model-connections/mock` body: the Local VPS development-only mock control (issue #47 — never available on a real VPS). */
export const MockProviderControlRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict()

export type ConnectionLifecycleState = z.infer<typeof ConnectionLifecycleStateSchema>
export type ModelConnectionMethodId = z.infer<typeof ModelConnectionMethodIdSchema>
export type ModelConnectionId = z.infer<typeof ModelConnectionIdSchema>
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>
export type DeviceChallenge = z.infer<typeof DeviceChallengeSchema>
export type ModelConnectionCapabilities = z.infer<typeof ModelConnectionCapabilitiesSchema>
export type ModelConnectionMethod = z.infer<typeof ModelConnectionMethodSchema>
export type ModelConnection = z.infer<typeof ModelConnectionSchema>
export type ModelConnectionSelection = z.infer<typeof ModelConnectionSelectionSchema>
export type ModelConnectionsSnapshot = z.infer<typeof ModelConnectionsSnapshotSchema>
export type CreateModelConnectionRequest = z.infer<typeof CreateModelConnectionRequestSchema>
export type AuthorizeModelConnectionRequest = z.infer<typeof AuthorizeModelConnectionRequestSchema>
export type AuthorizeModelConnectionResponse = z.infer<
  typeof AuthorizeModelConnectionResponseSchema
>
export type UpdateModelConnectionRequest = z.infer<typeof UpdateModelConnectionRequestSchema>
export type VerifyModelConnectionRequest = z.infer<typeof VerifyModelConnectionRequestSchema>
export type VerifyModelConnectionResponse = z.infer<typeof VerifyModelConnectionResponseSchema>
export type ApplyModelSelectionRequest = z.infer<typeof ApplyModelSelectionRequestSchema>
export type ModelConnectionCatalogResponse = z.infer<typeof ModelConnectionCatalogResponseSchema>
export type MockProviderControlRequest = z.infer<typeof MockProviderControlRequestSchema>
