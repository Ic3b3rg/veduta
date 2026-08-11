import { z } from 'zod'

/**
 * Hand-written zod schemas for the Codex app-server JSON-RPC messages
 * Veduta consumes (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment). Every
 * shape here is **transcribed** from the pinned `@openai/codex` version
 * `0.146.1` (source commit `9d00bb0`), per the research in
 * `docs/references/11-model-connections-manual-smoke.md` and the "what to
 * build" section of `issues/047-model-connections.md`. It is not generated
 * from the binary — the binary is absent from CI, and generating schemas at
 * build time would break an offline install.
 *
 * `initialize`, `account/login/start`, `account/read`, `model/list`, and —
 * after a successful local device authorization — one complete
 * `thread/start`/`turn/start` text turn were re-checked 2026-08-10 against
 * the real, pinned 0.146.1 binary itself. The binary was spoken to directly
 * over stdio; the turn capture covered its start responses plus
 * `item/started`, `item/agentMessage/delta`, `item/completed`, and
 * `turn/completed`. Each schema below whose doc comment says "observed" or
 * "CONFIRMED" was corrected against that live output; every field still
 * marked `transcription note` remains research-only.
 *
 * Required response and notification fields are the fail-closed contract:
 * an absent or mistyped required field becomes a typed `CodexProtocolError`.
 * Their schemas deliberately use plain `z.object`, which tolerates and
 * strips unknown keys. Additive upstream fields are inert to Veduta, and
 * rejecting them would turn routine protocol growth between patch releases
 * into a signed Veduta release without strengthening the boundary. This is
 * the response-parsing policy recorded by `issues/047-model-connections.md`.
 * Outbound params are built by `model-connection-codex.ts`, not parsed here;
 * schemas for params Veduta controls may remain strict if one is added.
 */

/** Thrown by `parseCodexResponse`/`parseCodexNotification` when a Codex app-server message does not match its pinned-protocol schema. Never thrown for a genuinely unknown notification method — those are ignored, not parsed. */
export class CodexProtocolError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(message)
    this.name = 'CodexProtocolError'
  }
}

/** Parses `raw` against `schema`; a mismatch becomes a `CodexProtocolError` naming the JSON-RPC method, never a guessed shape. */
export function parseCodexResponse<T>(schema: z.ZodType<T>, method: string, raw: unknown): T {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    throw new CodexProtocolError(
      method,
      `the Codex app-server's response to "${method}" did not match the pinned 0.146.1 protocol: ${parsed.error.message}`,
    )
  }
  return parsed.data
}

/**
 * `initialize` response, used by `model-connection-codex.ts`'s
 * `availability()`/`initializeCodexTransport()` to enforce the exact
 * `CODEX_PINNED_VERSION` pin. CONFIRMED 2026-08-10 by direct observation
 * against the real, pinned `@openai/codex@0.146.1` binary (installed with
 * `npm install @openai/codex@0.146.1` outside this repo, then run as
 * `codex app-server` and sent a live `initialize` request over stdio) —
 * this replaces an earlier, wrong `{ version: string }` guess that no real
 * 0.146.1 response ever matched, which made the ChatGPT method permanently
 * report itself unavailable. The real shape matches the v1 protocol's own
 * `InitializeResponse` struct (`codex-rs/app-server-protocol/src/protocol/v1.rs`
 * in `openai/codex` at commit `9d00bb0`): there is no separate `version`
 * field at all — the app-server's own version is embedded inside
 * `userAgent` (observed verbatim:
 * `"veduta/0.146.1 (Mac OS 26.5.1; arm64) unknown (veduta; 0.0.0)"`) and
 * extracted with `codexVersionFromUserAgent` in `model-connection-codex.ts`.
 */
export const InitializeResponseSchema = z.object({
  // observed 2026-08-10 — carries the app-server's own version, embedded
  // rather than a dedicated field (see the schema's own doc comment).
  userAgent: z.string().min(1),
  // observed 2026-08-10 — the CODEX_HOME path the app-server resolved for
  // this session; not read by this build.
  codexHome: z.string().min(1),
  // observed 2026-08-10 (value: "unix"); not read by this build.
  platformFamily: z.string().min(1),
  // observed 2026-08-10 (value: "macos"); not read by this build.
  platformOs: z.string().min(1),
})

/**
 * `account/login/start` response for `{ type: 'chatgptDeviceCode' }`:
 * CONFIRMED 2026-08-10 by direct observation against the real, pinned
 * binary without completing a login. The response carries the same
 * `chatgptDeviceCode` type discriminator as the request plus `loginId`,
 * `verificationUrl`, and `userCode`. `expiresAt` was absent from the live
 * response; it remains optional because the adapter already supports a
 * provider-reported expiry and otherwise applies its own 15-minute cap.
 */
export const LoginStartResponseSchema = z.object({
  // observed 2026-08-10 — discriminator for the device-code result variant.
  type: z.literal('chatgptDeviceCode'),
  loginId: z.string().min(1),
  verificationUrl: z.string().min(1),
  userCode: z.string().min(1),
  // transcription note: field name per 0.146.1 — ref-11 does not confirm
  // whether (or under what key) the app-server reports its own
  // device-code expiry; `model-connection-codex.ts` falls back to a
  // Veduta-declared 15-minute cap when this is absent
  // (`DeviceChallenge.expirySource`).
  expiresAt: z.string().min(1).optional(),
})

/** `account/login/completed` notification: `loginId` is the field a `refresh()` poll correlates against its own in-memory challenge. A canceled live login also carried `success` and `error`; those inert additions are intentionally tolerated. */
export const LoginCompletedNotificationSchema = z.object({
  loginId: z.string().min(1),
})

/**
 * `account/updated` notification. ref-11 records only that this follows
 * `account/login/completed` and carries "the ChatGPT plan type", without
 * pinning an exact key — and `model-connection-codex.ts`'s refresh flow
 * gets the plan type from `account/read`'s own response instead, so this
 * notification is drained and correlated by method name only; no field on
 * it is load-bearing here. Kept intentionally empty-shaped rather than
 * guessing a required key; the object check remains, while unknown fields
 * are tolerated.
 */
export const AccountUpdatedNotificationSchema = z.object({})

/**
 * `account/read` response (called with `{ refreshToken: true }`). The
 * envelope — a nullable `account` object plus a `requiresOpenaiAuth` flag —
 * is CONFIRMED 2026-08-10 by direct observation against the real, pinned
 * 0.146.1 binary with no ChatGPT account signed in: `account/read` answers
 * successfully (never a JSON-RPC error) with
 * `{ account: null, requiresOpenaiAuth: true }`, which supersedes an
 * earlier transcription that assumed a flat, always-populated object —
 * `model-connection-codex.ts`'s `readAccount` treats a `null` account as
 * `'expired'`, never `'connected'`. The fields INSIDE a signed-in `account`
 * object remain transcription-based: ref-11 confirms only that the call
 * reports "account and plan state" without pinning exact keys, and this
 * research never logs in to observe the authenticated shape (issue #47's
 * ground rule — no credentials are touched). Modeled conservatively — both
 * fields optional — so an authenticated response carrying either (or
 * neither) still parses; `label` in `RefreshResult.account` falls back
 * through `planType` → `email` → a fixed "ChatGPT" string in
 * `model-connection-codex.ts`.
 */
export const AccountReadResponseSchema = z.object({
  account: z
    .object({
      // transcription note: field name per 0.146.1 — NOT independently
      // observed (auth-gated).
      email: z.string().min(1).optional(),
      // transcription note: field name per 0.146.1 — the "plan type"
      // ref-11 says `account/updated` carries; used here instead since it
      // is `account/read`'s response this adapter actually reads for the
      // connected account label. NOT independently observed (auth-gated).
      planType: z.string().min(1).optional(),
    })
    .nullable(),
  // observed 2026-08-10 — true when no ChatGPT account is signed in.
  requiresOpenaiAuth: z.boolean(),
})

/** `account/logout` response: the supported disconnect call. ref-11 records no required response field beyond a successful JSON-RPC result, so any object is accepted and unknown fields are ignored. */
export const LogoutResponseSchema = z.object({})

/**
 * One entry of `model/list`'s catalog (issue #47: "show the full returned
 * catalog without a curated subset"). `.passthrough()` deliberately, not
 * `.strict()` — CONFIRMED 2026-08-10 by direct observation against the
 * real, pinned 0.146.1 binary (`model/list` answers without a ChatGPT
 * login, so this call — unlike `account/read` above — was directly
 * observable end to end): a real entry carries at least a dozen further
 * fields this build has no use for (`model`, `upgrade`, `upgradeInfo`,
 * `availabilityNux`, `modelSpecialty`, `hidden`, `supportedReasoningEfforts`,
 * `defaultReasoningEffort`, `inputModalities`, `supportsPersonality`,
 * `additionalSpeedTiers`, `serviceTiers`, `defaultServiceTier`). None of
 * that is drift — it is the catalog's ordinary shape — so a `.strict()`
 * schema here would reject every real response on fields it never asked
 * about.
 */
export const CodexModelEntrySchema = z
  .object({
    id: z.string().min(1),
    // observed 2026-08-10 — the display name this transcription originally
    // guessed was called `label`; the real field is `displayName`. Falls
    // back to `id` in `model-connection-codex.ts` when absent.
    displayName: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    // observed 2026-08-10 — the "default marker" ref-11 describes.
    isDefault: z.boolean().optional(),
  })
  .passthrough()

/**
 * `model/list` response: cursor-paginated, exhausted by
 * `model-connection-codex.ts`'s `catalog()`. CONFIRMED 2026-08-10 by direct
 * observation (see `CodexModelEntrySchema`'s own doc comment): the catalog
 * array is keyed `data`, not `models` as this transcription originally
 * guessed, and an exhausted `nextCursor` is reported as `null`, not simply
 * absent.
 */
export const ModelListResponseSchema = z.object({
  data: z.array(CodexModelEntrySchema),
  nextCursor: z.string().min(1).nullable().optional(),
})

/**
 * `thread/start` response (issue #47,
 * docs/adr/0014-subscription-inference-boundary.md): confirms only the
 * fresh thread's id. CONFIRMED 2026-08-10 against the pinned 0.146.1
 * binary: the id is nested under `thread.id`, not returned as a top-level
 * `threadId`. The response carries no field this
 * transcription can assert an empty tool set against, so the fail-closed
 * proof that a Codex turn cannot act lives in `model-connection-codex.ts`'s
 * `stream()` instead — a runtime check against every streamed item, not a
 * start-time assertion on this response.
 */
export const ThreadStartResponseSchema = z.object({
  thread: z.object({ id: z.string().min(1) }),
})

/** `turn/start` response, CONFIRMED 2026-08-10 against the pinned binary: the id a later `turn/interrupt` (or streamed item/turn notification) correlates against is nested under `turn.id`. */
export const TurnStartResponseSchema = z.object({
  turn: z.object({ id: z.string().min(1) }),
})

/**
 * One streamed item, as carried by an `item/started` or `item/completed`
 * notification during a turn (issue #47). CONFIRMED 2026-08-10 against a
 * live 0.146.1 turn; incremental assistant text arrives separately in an
 * `item/agentMessage/delta` envelope.
 * `type` is the discriminator `model-connection-codex.ts`'s `stream()`
 * switches on: `'agentMessage'` is forwarded as text, `'userMessage'` is
 * the inert echo of Veduta's own input, `'reasoning'` is silently dropped,
 * and ANY other value — a real one this transcription
 * does not yet name (command execution, patch application, web search, an
 * MCP tool call) or a genuinely unrecognized one — is the runtime-observable
 * proof the turn attempted to act outside plain assistant text, and refuses
 * the turn. `.passthrough()` on the item body (rather than `.strict()`) is
 * deliberate: an item type this transcription has not seen a real payload
 * for must still parse — only its `type` matters to the refusal decision,
 * never its other fields — where a `.strict()` schema would instead throw a
 * `CodexProtocolError` and defeat the very case this guard exists to catch.
 */
export const CodexItemSchema = z
  .object({
    // Observed 2026-08-10 on every `item/started`/`item/completed` payload;
    // also correlates a completed assistant item with its delta envelopes.
    id: z.string().min(1),
    // Observed item type discriminator per 0.146.1 — the values this build
    // recognizes are `'userMessage'`, `'agentMessage'`, and `'reasoning'`;
    // every other value (including one this transcription has never
    // observed) is treated as a tool-shaped item and refuses the turn.
    type: z.string().min(1),
    // Observed field name per 0.146.1 — an `'agentMessage'` item's current
    // or finalized text (`item/started`/`item/completed`).
    text: z.string().optional(),
  })
  .passthrough()

/** Recognized non-acting item type values observed against the pinned binary. */
export const CODEX_TEXT_ITEM_TYPE = 'agentMessage'
export const CODEX_USER_ITEM_TYPE = 'userMessage'
export const CODEX_REASONING_ITEM_TYPE = 'reasoning'

/** `item/started` or `item/completed` notification, CONFIRMED 2026-08-10: both correlation ids and `item` stay required while timestamp/additive fields are tolerated. */
export const ItemNotificationSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  item: CodexItemSchema,
})

/** `item/agentMessage/delta` notification, CONFIRMED 2026-08-10 against a live pinned-binary turn. */
export const AgentMessageDeltaNotificationSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  delta: z.string(),
})

/** `turn/completed` notification, CONFIRMED 2026-08-10 against the pinned binary: the completed turn id is nested under `turn.id`. */
export const TurnCompletedNotificationSchema = z.object({
  threadId: z.string().min(1),
  turn: z.object({ id: z.string().min(1) }),
})

export type InitializeResponse = z.infer<typeof InitializeResponseSchema>
export type LoginStartResponse = z.infer<typeof LoginStartResponseSchema>
export type LoginCompletedNotification = z.infer<typeof LoginCompletedNotificationSchema>
export type AccountUpdatedNotification = z.infer<typeof AccountUpdatedNotificationSchema>
export type AccountReadResponse = z.infer<typeof AccountReadResponseSchema>
export type LogoutResponse = z.infer<typeof LogoutResponseSchema>
export type CodexModelEntry = z.infer<typeof CodexModelEntrySchema>
export type ModelListResponse = z.infer<typeof ModelListResponseSchema>
export type ThreadStartResponse = z.infer<typeof ThreadStartResponseSchema>
export type TurnStartResponse = z.infer<typeof TurnStartResponseSchema>
export type CodexItem = z.infer<typeof CodexItemSchema>
export type ItemNotification = z.infer<typeof ItemNotificationSchema>
export type AgentMessageDeltaNotification = z.infer<typeof AgentMessageDeltaNotificationSchema>
export type TurnCompletedNotification = z.infer<typeof TurnCompletedNotificationSchema>

/** A notification frame after the protocol layer has had a chance to recognize its method. An unrecognized method is deliberately NOT parsed — `params` passes through opaque — so a future notification type cannot fail validation on the way to being ignored. */
export type CodexNotification =
  | { method: 'account/login/completed'; params: LoginCompletedNotification }
  | { method: 'account/updated'; params: AccountUpdatedNotification }
  | { method: string; params: unknown }

/**
 * Dispatches one notification frame by method name: a recognized method's
 * required fields are parsed (a mismatch throws `CodexProtocolError`, the
 * same as any consumed response) while unknown fields are tolerated; an
 * unrecognized method is ignored — returned with its `params` untouched,
 * never parsed, never fatal. This is the ONE place that decides which
 * notification methods this build recognizes.
 */
export function parseCodexNotification(method: string, params: unknown): CodexNotification {
  switch (method) {
    case 'account/login/completed':
      return {
        method,
        params: parseCodexResponse(LoginCompletedNotificationSchema, method, params),
      }
    case 'account/updated':
      return {
        method,
        params: parseCodexResponse(AccountUpdatedNotificationSchema, method, params),
      }
    default:
      return { method, params }
  }
}
