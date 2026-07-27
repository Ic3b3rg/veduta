import { z } from 'zod'
import { ByokProviderSchema, OnboardingStatusSchema } from './onboarding.ts'

/**
 * The two legacy agents this importer reads from (issue 020, `tasks/plan.md`
 * "Source layouts"): OpenClaw (`~/.openclaw`, legacy aliases `~/.clawdbot`,
 * `~/.moltbot`) and Hermes (`~/.hermes`). `source` is always this enum, never
 * a path — the daemon resolves the directory itself (staged dir, then
 * `resolveLegacy`, then `homedir()`), so no client request can point the
 * importer anywhere (`tasks/plan.md` "Wire API").
 */
export const ImportSourceKindSchema = z.enum(['openclaw', 'hermes'])

/**
 * What the plan decided to do with one mapped item. Conflicts refuse rather
 * than silently skip (`tasks/plan.md` design decision 8, issue AC2):
 * `overwrite` only appears once `ImportOptions.overwrite` is set and the item
 * was a conflict; `skip` is reserved for the secrets-without-`--secrets` case
 * and other flag-gated omissions, never for an unresolved conflict.
 */
export const ImportActionSchema = z.enum(['import', 'overwrite', 'skip'])

/**
 * One line of the human-and-machine-readable plan (`tasks/plan.md` design
 * decision 7: the preview must describe exactly the run apply performs).
 * `target` is a path or a logical target such as `SOUL.md` or
 * `spaces/imported/FACTS.md` — never the source path (that would leak the
 * admin's home directory layout into a client-rendered preview). `detail` is
 * always a human-readable line describing the item — a fact's first words, a
 * file's byte count, a secret's provider name — **never** a secret value
 * (`tasks/plan.md` design decision 4, decision 12: names only).
 */
export const ImportItemSchema = z.object({
  action: ImportActionSchema,
  target: z.string().min(1),
  detail: z.string().min(1),
  reason: z.string().min(1).optional(),
  count: z.number().int().nonnegative().optional(),
})

/**
 * The options that gate a run (`tasks/plan.md` design decision 7): the same
 * shape is accepted by preview and apply, so toggling `overwrite` in the
 * wizard re-previews before `--apply`/Apply is offered, and `ImportResult`
 * can echo the options actually executed. `secrets` defaults to `false` —
 * importing a provider key is opt-in even from the CLI (decision 12).
 */
export const ImportOptionsSchema = z.object({
  overwrite: z.boolean().default(false),
  secrets: z.boolean().default(false),
})

/**
 * The full dry-run plan (`tasks/plan.md` design decision 6: `readTargetState`
 * is pure `fs`, so building this plan never constructs a `SpacesEngine` and
 * never writes anything). `warnings` are non-blocking notices (an unsupported
 * `.env` line, a legacy alias in use); `notMigrated` lists runtime state that
 * is deliberately never copied (`sessions/`, `logs/`, `state.db`); `blocked`
 * lists the hard refusals from decision 8 that `overwrite` cannot clear —
 * apply throws `ImportRefusedError` whenever this is non-empty.
 * `requiresOverwrite` is true when at least one item is a conflict that only
 * `overwrite: true` would resolve, so the wizard knows when to surface the
 * toggle at all (`tasks/plan.md` T8 AC). `alreadyImported` is populated from
 * `<root>/import.json` (decision 8's import marker) when this exact source
 * was imported before, so a second apply without `--overwrite` can name the
 * previous run instead of silently re-running.
 */
export const ImportPlanSchema = z.object({
  source: ImportSourceKindSchema,
  sourceDir: z.string().min(1),
  options: ImportOptionsSchema,
  items: z.array(ImportItemSchema),
  warnings: z.array(z.string()),
  notMigrated: z.array(z.string()),
  blocked: z.array(z.string()),
  requiresOverwrite: z.boolean(),
  alreadyImported: z
    .object({
      source: ImportSourceKindSchema,
      at: z.string().datetime(),
    })
    .optional(),
  /**
   * The full adapted `SOUL.md` text, present exactly when `items` has a
   * non-skip `SOUL.md` entry (`tasks/plan.md` design decision 3,
   * `docs/adr/0010-importer-trust-and-refusal.md`). SOUL is the one imported
   * file that cannot be rendered as delimited data — it *is*
   * instructions — so decision 3's mitigation is that the user reads the
   * exact text before anything is written, not a byte count and a warning
   * with nothing to act on. This carries the ADAPTED text (invariants
   * written first, rebranded, delimiter-neutralized, redacted) — the same
   * string `import-apply.ts` writes to disk, never the raw source file — so
   * what the preview shows and what lands on `SOUL.md` cannot diverge
   * (`import-plan.ts` and `import-apply.ts` both call `adaptSoul` with the
   * same arguments). Absent whenever SOUL is skipped or the plan is blocked.
   */
  soulPreview: z.string().optional(),
})

/**
 * The Curator's four operations (`packages/daemon/src/facts.ts`'s
 * `CuratorOperation`: `'add' | 'update' | 'supersede' | 'noop'`), counted per
 * run, plus `overflow` — entries that exceeded the FACTS budget (100 entries,
 * `tasks/plan.md` T4 AC) and were appended to the Event log instead of FACTS.
 * Every count is reported, never silently dropped, so `ImportResult` can
 * state exactly what happened to every parsed memory entry.
 */
export const ImportFactCountsSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  superseded: z.number().int().nonnegative(),
  noop: z.number().int().nonnegative(),
  overflow: z.number().int().nonnegative(),
})

/**
 * What actually happened when a plan was applied (`tasks/plan.md` T5 AC1).
 * `plan` echoes the plan executed inside the lock (decision 7 — drift between
 * preview and apply must be visible, never assumed away). `backupPath` is the
 * `createBackup` output (decision 10); `archiveDir`/`notesPath` are the
 * `import-archive/<source>-<ts>/` directory and its `NOTES.md` (decision 11).
 * `spaceId` is the reconciled-by-slug `imported` Space (decision 18) —
 * omitted only when nothing was written there. `secretsImported` lists vault
 * entry **names** only — the three `ByokProviderSchema` values (`anthropic`,
 * `openai`, `openrouter`), reused rather than `z.string()` so this field
 * cannot validate a literal secret value that happened to slip through
 * (decision 12: names only, never values); it is empty whenever
 * `options.secrets` was false.
 */
export const ImportResultSchema = z.object({
  plan: ImportPlanSchema,
  backupPath: z.string().min(1),
  archiveDir: z.string().min(1),
  notesPath: z.string().min(1),
  spaceId: z.string().min(1).optional(),
  facts: ImportFactCountsSchema,
  eventsAppended: z.number().int().nonnegative(),
  soulUpdated: z.boolean(),
  userUpdated: z.boolean(),
  secretsImported: z.array(ByokProviderSchema),
})

/**
 * The shape shared by both the preview and apply request bodies
 * (`tasks/plan.md` "Wire API", decision 7: option parity). `.strict()` so an
 * unexpected key is a 400 rather than silently ignored (matches
 * `onboarding.ts`'s request schemas). `secrets: true` from the wizard is
 * rejected with a 400 (decision 16 — the wizard path is secret-free by
 * construction; `--secrets` stays CLI-only).
 *
 * B14 (code review): `ImportPreviewRequestSchema` and
 * `ImportApplyRequestSchema` used to be two byte-for-byte copies of this
 * same object, justified as "possible future divergence" — an actual
 * duplication finding, not a real seam, since nothing distinguished them.
 * Defined once here and aliased under both public names below, so the two
 * routes can still diverge later (by pointing one alias at a new schema)
 * without a breaking rename, but today's identical shape is no longer
 * hand-copied twice.
 */
const ImportPreviewOrApplyRequestSchema = z
  .object({
    source: ImportSourceKindSchema,
    overwrite: z.boolean().default(false),
    secrets: z.boolean().default(false),
  })
  .strict()

/** `POST /api/onboarding/migration/preview` body — see `ImportPreviewOrApplyRequestSchema`. */
export const ImportPreviewRequestSchema = ImportPreviewOrApplyRequestSchema

/** `POST /api/onboarding/migration/import` body — see `ImportPreviewOrApplyRequestSchema`. */
export const ImportApplyRequestSchema = ImportPreviewOrApplyRequestSchema

/**
 * `POST /api/onboarding/migration/import` response. `status` is the same
 * `OnboardingStatusSchema` returned by `GET /api/onboarding`, refreshed after
 * a successful import sets `migrationChoice: 'imported'` and marks the
 * `migration` step `completed` (`tasks/plan.md` "Wire API"), so the wizard
 * never has to issue a second round trip to advance.
 */
export const ImportApplyResponseSchema = z.object({
  result: ImportResultSchema,
  status: OnboardingStatusSchema,
})

export type ImportSourceKind = z.infer<typeof ImportSourceKindSchema>
export type ImportAction = z.infer<typeof ImportActionSchema>
export type ImportItem = z.infer<typeof ImportItemSchema>
export type ImportOptions = z.infer<typeof ImportOptionsSchema>
export type ImportOptionsInput = z.input<typeof ImportOptionsSchema>
export type ImportPlan = z.infer<typeof ImportPlanSchema>
export type ImportFactCounts = z.infer<typeof ImportFactCountsSchema>
export type ImportResult = z.infer<typeof ImportResultSchema>
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequestSchema>
export type ImportPreviewRequestInput = z.input<typeof ImportPreviewRequestSchema>
export type ImportApplyRequest = z.infer<typeof ImportApplyRequestSchema>
export type ImportApplyRequestInput = z.input<typeof ImportApplyRequestSchema>
export type ImportApplyResponse = z.infer<typeof ImportApplyResponseSchema>
