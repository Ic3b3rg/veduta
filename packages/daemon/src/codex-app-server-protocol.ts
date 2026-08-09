import { z } from 'zod'

/**
 * Hand-written, strict zod schemas for the Codex app-server JSON-RPC
 * messages Veduta consumes (issue #47,
 * `docs/adr/0014-subscription-inference-boundary.md` amendment). Every
 * shape here is **transcribed** from the pinned `@openai/codex` version
 * `0.146.1` (source commit `9d00bb0`), per the research in
 * `docs/references/11-model-connections-manual-smoke.md` and the "what to
 * build" section of `issues/047-model-connections.md`. It is not generated
 * from the binary — the binary is absent from CI, and generating schemas at
 * build time would break an offline install — so a real 0.146.1 response
 * shaped differently than transcribed here is a bug in this transcription,
 * to be fixed by re-reading the pinned source, never by loosening a schema
 * to "make it pass".
 *
 * Every schema is `.strict()`: a response carrying an unexpected extra
 * field fails the parse rather than being silently accepted, and
 * `parseCodexResponse` turns that failure into a typed `CodexProtocolError`
 * — a strict-parse mismatch is a signal that this transcription (or the
 * live binary) drifted from the pin, never something to guess past. Where
 * ref-11's research did not pin an exact field name or nesting, the field
 * is marked `transcription note` and kept optional rather than invented —
 * an absent field never fails the parse, only a field of the wrong type
 * does.
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
 * `initialize` response: the app-server's own reported version, used by
 * `model-connection-codex.ts`'s `availability()` to enforce the exact
 * `CODEX_PINNED_VERSION` pin. `.strict()` deliberately rejects any other
 * reported field — a future app-server response carrying more than a
 * version is exactly the kind of drift this pin exists to catch, not to
 * silently tolerate.
 */
export const InitializeResponseSchema = z
  .object({
    // transcription note: field name per 0.146.1 — the initialize response
    // reports the app-server's own version so a caller can enforce a pin
    // without shelling out to a separate `--version` flag.
    version: z.string().min(1),
  })
  .strict()

/**
 * `account/login/start` response for `{ type: 'chatgptDeviceCode' }`:
 * `loginId`, `verificationUrl`, `userCode` are the three fields ref-11's
 * research confirms by name. `expiresAt` is NOT confirmed — ref-11 records
 * only that Veduta must fall back to its own 15-minute cap when the
 * provider does not report one — so it stays optional and marked.
 */
export const LoginStartResponseSchema = z
  .object({
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
  .strict()

/** `account/login/completed` notification: the one field ref-11 confirms — the `loginId` a `refresh()` poll correlates against its own in-memory challenge. */
export const LoginCompletedNotificationSchema = z
  .object({
    loginId: z.string().min(1),
  })
  .strict()

/**
 * `account/updated` notification. ref-11 records only that this follows
 * `account/login/completed` and carries "the ChatGPT plan type", without
 * pinning an exact key — and `model-connection-codex.ts`'s refresh flow
 * gets the plan type from `account/read`'s own response instead, so this
 * notification is drained and correlated by method name only; no field on
 * it is load-bearing here. Kept intentionally empty-shaped rather than
 * guessing a key that would then gate a strict parse on an invented field.
 */
export const AccountUpdatedNotificationSchema = z.object({}).strict()

/**
 * `account/read` response (called with `{ refreshToken: true }`): ref-11
 * confirms this reports "account and plan state" without pinning exact
 * keys. Modeled conservatively — both fields optional — so a real response
 * carrying either (or neither) still parses; `label` in
 * `RefreshResult.account` falls back through `planType` → `email` →
 * a fixed "ChatGPT" string in `model-connection-codex.ts`.
 */
export const AccountReadResponseSchema = z
  .object({
    // transcription note: field name per 0.146.1
    email: z.string().min(1).optional(),
    // transcription note: field name per 0.146.1 — the "plan type" ref-11
    // says `account/updated` carries; used here instead since it is
    // `account/read`'s response this adapter actually reads for the
    // connected account label.
    planType: z.string().min(1).optional(),
  })
  .strict()

/** `account/logout` response: the supported disconnect call. ref-11 records no response payload beyond success — modeled as an empty object; any field would be an unexpected drift. */
export const LogoutResponseSchema = z.object({}).strict()

/** One entry of `model/list`'s catalog (issue #47: "show the full returned catalog without a curated subset"). */
export const CodexModelEntrySchema = z
  .object({
    id: z.string().min(1),
    // transcription note: field name per 0.146.1 — ref-11 confirms the
    // response carries display metadata without pinning its key; falls
    // back to `id` in `model-connection-codex.ts` when absent.
    label: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    // transcription note: field name per 0.146.1 — the "default marker"
    // ref-11 describes.
    isDefault: z.boolean().optional(),
  })
  .strict()

/** `model/list` response: cursor-paginated, exhausted by `model-connection-codex.ts`'s `catalog()`. */
export const ModelListResponseSchema = z
  .object({
    models: z.array(CodexModelEntrySchema),
    nextCursor: z.string().min(1).optional(),
  })
  .strict()

/**
 * `thread/start` response (issue #47,
 * docs/adr/0014-subscription-inference-boundary.md): confirms only the
 * fresh thread's id. The pinned 0.146.1 response carries no field this
 * transcription can assert an empty tool set against, so the fail-closed
 * proof that a Codex turn cannot act lives in `model-connection-codex.ts`'s
 * `stream()` instead — a runtime check against every streamed item, not a
 * start-time assertion on this response.
 */
export const ThreadStartResponseSchema = z
  .object({
    // transcription note: field name per 0.146.1.
    threadId: z.string().min(1),
  })
  .strict()

/** `turn/start` response: confirms the turn id a later `turn/interrupt` (or a streamed item/turn notification) correlates against. */
export const TurnStartResponseSchema = z
  .object({
    // transcription note: field name per 0.146.1.
    turnId: z.string().min(1),
  })
  .strict()

/**
 * One streamed item, as carried by an `item/updated` (incremental) or
 * `item/completed` (finalized) notification during a turn (issue #47).
 * `type` is the discriminator `model-connection-codex.ts`'s `stream()`
 * switches on: `'agentMessage'` is forwarded as text, `'reasoning'` is
 * silently dropped, and ANY other value — a real one this transcription
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
    // transcription note: item type discriminator per 0.146.1 — the values
    // this build recognizes are `'agentMessage'` and `'reasoning'`; every
    // other value (including one this transcription has never observed) is
    // treated as a tool-shaped item and refuses the turn.
    type: z.string().min(1),
    // transcription note: field name per 0.146.1 — an `'agentMessage'`
    // item's finalized text (`item/completed`).
    text: z.string().optional(),
    // transcription note: field name per 0.146.1 — an `'agentMessage'`
    // item's incremental text (`item/updated`).
    delta: z.string().optional(),
  })
  .passthrough()

/** The recognized `'agentMessage'` item type value (issue #47) — forwarded as text; `'reasoning'` is the other recognized value and is always dropped. */
export const CODEX_TEXT_ITEM_TYPE = 'agentMessage'
export const CODEX_REASONING_ITEM_TYPE = 'reasoning'

/** `item/updated` or `item/completed` notification (issue #47): the top-level envelope is fixed (`.strict()`); the nested item stays `.passthrough()` per `CodexItemSchema`'s own doc comment. */
export const ItemNotificationSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1).optional(),
    item: CodexItemSchema,
  })
  .strict()

/** `turn/completed` notification: the turn finished with no further items to stream. */
export const TurnCompletedNotificationSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1).optional(),
  })
  .strict()

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
export type TurnCompletedNotification = z.infer<typeof TurnCompletedNotificationSchema>

/** A notification frame after the protocol layer has had a chance to recognize its method. An unrecognized method is deliberately NOT parsed — `params` passes through opaque — so a future notification type never fails a strict parse on the way to being ignored. */
export type CodexNotification =
  | { method: 'account/login/completed'; params: LoginCompletedNotification }
  | { method: 'account/updated'; params: AccountUpdatedNotification }
  | { method: string; params: unknown }

/**
 * Dispatches one notification frame by method name: a recognized method is
 * strict-parsed (a mismatch throws `CodexProtocolError`, the same as any
 * consumed response); an unrecognized method is ignored — returned with its
 * `params` untouched, never parsed, never fatal. This is the ONE place that
 * decides which notification methods this build recognizes.
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
