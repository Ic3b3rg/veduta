import { z } from 'zod'

/**
 * The onboarding wizard's step order:
 * `migration` (only surfaced when a legacy Hermes/OpenClaw install is detected) →
 * `domain` → `byok` → `models` → `first-space` → `integrations` → `finish`.
 * `first-space` precedes `integrations` because every ingestion source requires a
 * target `spaceId` (`ingestion-config.ts`) — the issue's list is descriptive, this
 * order is structural. See `issues/019-onboarding-wizard.md`.
 */
export const OnboardingStepIdSchema = z.enum([
  'migration',
  'domain',
  'byok',
  'models',
  'first-space',
  'integrations',
  'finish',
])

/**
 * Per-step completion state persisted in `onboarding.json`. `skipped` covers the
 * one-tap-skip steps (BYOK falls back to the mock provider; integrations are
 * optional) — distinct from `completed` so the status view can render "skipped"
 * copy rather than implying the step actually ran.
 */
export const OnboardingStepStatusSchema = z.enum(['pending', 'completed', 'skipped'])

/**
 * The two deploy profiles from `CONTEXT.md` that gate whether the wizard is
 * required at all: `loopback` (`pnpm dev`, no
 * `VEDUTA_PUBLIC_DOMAIN`, mock provider) never requires onboarding unless
 * `VEDUTA_ONBOARDING=force` is set for verification; `vps`
 * (`VEDUTA_PUBLIC_DOMAIN` set — ACME TLS, passkeys, enforced egress) requires
 * it until `onboarding.json` is marked completed. "Local VPS" rehearsals
 * (ADR-0009) still report as `vps` here — the distinction is deployment
 * topology, not onboarding behavior.
 */
export const OnboardingProfileSchema = z.enum(['loopback', 'vps'])

/**
 * Status of one installer stage, mirrored from the Hermes-style JSON stage
 * protocol (see `InstallerStageEventSchema` below).
 */
export const InstallerStageStatusSchema = z.enum([
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
])

export const InstallerStageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: InstallerStageStatusSchema,
})

/**
 * The installer (`deploy/install.sh`) emits one of these as a single JSON
 * object per stdout line after every stage transition (human-readable text
 * goes to stderr instead, so stdout stays machine-parseable) — a Hermes-style
 * stage protocol (`docs/references/04-onboarding-migration.md` §A: "a GUI can
 * render the installer's progress bar without reimplementing it"). The final
 * stage snapshot is also written to `<dataDir>/installer-stages.json` so the
 * wizard can render an installer summary even when it starts after the
 * install already finished. `snake_case` keys
 * (`protocol_version`, `needs_user_input`) are deliberate: they match the
 * Hermes wire format this protocol is derived from, not this repo's usual
 * camelCase convention.
 */
export const InstallerStageEventSchema = z.object({
  protocol_version: z.literal(1),
  stages: z.array(InstallerStageSchema).min(1),
  needs_user_input: z.boolean(),
})

/**
 * Result of scanning the invoking admin's home directory for a legacy agent
 * install (`~/.hermes`, `~/.openclaw`) before any escalation side effects
 * (the installer's `legacy-detect` stage). Captured by the installer and
 * persisted into `onboarding.json` so the daemon — which runs as the
 * `veduta` user under `ProtectHome=yes` and can never see `/home/*` itself —
 * can offer the `migration` step first. `sourceHome` is the detected legacy
 * home directory, when found, so the importer (`import-source.ts`'s
 * `resolveLegacyDir`, issue 020) knows where to read from.
 */
export const LegacyDetectionSchema = z.object({
  openclaw: z.boolean(),
  hermes: z.boolean(),
  sourceHome: z.string().min(1).optional(),
})

/** One model assignment within a routing tier — mirrors `TierModelSchema` in `model-routing.ts`. */
export const OnboardingTierModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
})

/**
 * The two model tiers from `model-routing.ts`'s `RoutingConfigSchema.tiers`:
 * `triage` (cheap/fast classification) and `reasoning` (chat turns, heartbeat
 * reasoning). The `models` onboarding step edits this shape directly so it
 * can be validated against the same routing schema on the daemon side.
 */
export const OnboardingTiersSchema = z.object({
  triage: z.array(OnboardingTierModelSchema).min(1),
  reasoning: z.array(OnboardingTierModelSchema).min(1),
})

/** BYOK providers offered by the wizard — hosts are `PROVIDER_HOSTS` in `server.ts`. */
export const ByokProviderSchema = z.enum(['anthropic', 'openai', 'openrouter'])

/**
 * `GET /api/onboarding` response: the single source of
 * truth for resuming the wizard (resume = first incomplete step) and for
 * pre-filling every step's form with current values as defaults (Hermes
 * discipline — never re-ask for a value the daemon already has). Secret
 * values are never included, only `hasKey`/`hasCredentials` booleans; the
 * caller learns whether a credential is configured, never what it is.
 */
export const OnboardingStatusSchema = z.object({
  required: z.boolean(),
  completed: z.boolean(),
  profile: OnboardingProfileSchema,
  currentStep: OnboardingStepIdSchema.nullable(),
  steps: z.array(
    z.object({
      id: OnboardingStepIdSchema,
      status: OnboardingStepStatusSchema,
    }),
  ),
  legacy: LegacyDetectionSchema,
  installer: InstallerStageEventSchema.optional(),
  domain: z.object({
    domain: z.string().nullable(),
    tlsActive: z.boolean(),
  }),
  byok: z.object({
    vaultAvailable: z.boolean(),
    providers: z.array(
      z.object({
        provider: ByokProviderSchema,
        hasKey: z.boolean(),
      }),
    ),
  }),
  models: z.object({
    tiers: OnboardingTiersSchema,
  }),
  firstSpace: z.object({
    suggestedName: z.string().min(1),
    existingSpaces: z.array(
      z.object({
        id: z.string().min(1),
        slug: z.string().min(1),
        name: z.string().min(1),
      }),
    ),
  }),
  integrations: z.object({
    gmail: z.object({
      configured: z.boolean(),
      hasCredentials: z.boolean(),
      /** Non-secret resume defaults, pre-filled from the vault/ingestion config — never a secret value. */
      clientId: z.string().min(1).optional(),
      topicName: z.string().min(1).optional(),
      subscription: z.string().min(1).optional(),
    }),
    calendar: z.object({
      configured: z.boolean(),
      hasCredentials: z.boolean(),
      /** Non-secret resume defaults, pre-filled from the vault/ingestion config — never a secret value. */
      clientId: z.string().min(1).optional(),
      calendarId: z.string().min(1).optional(),
    }),
  }),
})

/**
 * `POST /api/onboarding/migration` body. An honest deferral: recording
 * `migrate-later` does not run anything — it just marks the choice. The
 * importer itself is reached separately, via `/api/onboarding/migration/preview`
 * and `/api/onboarding/migration/import` (`onboarding-step-migration.ts`,
 * issue 020), which set `migrationChoice: 'imported'` on success. No fake
 * command is printed for either choice here.
 */
export const MigrationChoiceRequestSchema = z.object({
  choice: z.enum(['migrate-later', 'manual']),
})

/**
 * `POST /api/onboarding/byok/test` body. `key` omitted means "test the
 * stored vault key" — the keep-existing sentinel used throughout the wizard
 * so a resumed session never has to re-enter a secret it already has.
 */
export const ByokTestRequestSchema = z.object({
  provider: ByokProviderSchema,
  key: z.string().min(1).optional(),
})

/**
 * `POST /api/onboarding/byok/test` response. The check is a deterministic
 * key check, not an LLM turn: `valid` (2xx from the
 * provider's models endpoint), `invalid` (401/403), or `unreachable`
 * (network error, timeout, or any other status).
 */
export const ByokTestResponseSchema = z.object({
  result: z.enum(['valid', 'invalid', 'unreachable']),
})

/**
 * `POST /api/onboarding/byok` body. Either skip (loopback/Local VPS fall
 * back to the mock provider; VPS profile prints the vault CLI dead-end
 * command) or store a key for a provider. `key` omitted on the provider
 * branch means "keep the existing stored key" — the same keep-existing
 * sentinel as `ByokTestRequestSchema`.
 */
export const ByokApplyRequestSchema = z.union([
  z.object({ skip: z.literal(true) }),
  z.object({
    provider: ByokProviderSchema,
    key: z.string().min(1).optional(),
  }),
])

/** `POST /api/onboarding/models` body — validated again against `RoutingConfigSchema.tiers` on the daemon. */
export const ModelsApplyRequestSchema = z.object({
  tiers: OnboardingTiersSchema,
})

/**
 * `POST /api/onboarding/first-space` body. The daemon slugifies `name` and
 * reconciles by slug: an existing non-archived Space with the resulting slug
 * is treated as already created (no duplicate `name-2`) rather than creating
 * a second Space on a re-applied (e.g. crash-retried) request.
 */
export const FirstSpaceRequestSchema = z.object({
  name: z.string().min(1).max(80),
})

/**
 * Gmail half of `POST /api/onboarding/integrations`. Fields mirror what
 * `IngestionSourceSchema` actually requires for a gmail source; the daemon
 * derives the rest (verification channel-token, push address, `spaceId`).
 * `clientSecret`/`refreshToken` omitted means "keep the existing stored
 * value" — the keep-existing sentinel, so a crash between the vault write
 * and the status write never forces re-entering credentials.
 */
export const GmailIntegrationRequestSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  topicName: z.string().min(1),
  subscription: z.string().min(1),
})

/** Calendar half of `POST /api/onboarding/integrations`; same keep-existing sentinel as gmail. */
export const CalendarIntegrationRequestSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
  calendarId: z.string().min(1).default('primary'),
})

/**
 * `POST /api/onboarding/integrations` body: either skip (one-tap, everything
 * activates after the finish-step restart is honestly deferred instead) or
 * at least one of gmail/calendar. The `.refine` rejects the degenerate case
 * of submitting the object branch with neither integration set — that
 * should have been the skip branch instead.
 */
export const IntegrationsApplyRequestSchema = z.union([
  z.object({ skip: z.literal(true) }),
  z
    .object({
      gmail: GmailIntegrationRequestSchema.optional(),
      calendar: CalendarIntegrationRequestSchema.optional(),
    })
    .refine((value) => value.gmail !== undefined || value.calendar !== undefined, {
      message: 'at least one integration required',
    }),
])

/**
 * `POST /api/onboarding/finish` response. On the VPS profile the daemon
 * exits gracefully ~500ms later so systemd (`Restart=always`) reboots it
 * with the new boot-time-immutable routing/vault/ingestion config —
 * `restarting` tells the PWA to poll `/api/health` instead of navigating
 * immediately. On loopback/Local VPS there is no exit: `restartRequired`
 * is true and the finish screen honestly says the new config takes effect
 * on the next daemon start.
 */
export const FinishResponseSchema = z.object({
  restartRequired: z.boolean(),
  restarting: z.boolean(),
})

export type OnboardingStepId = z.infer<typeof OnboardingStepIdSchema>
export type OnboardingStepStatus = z.infer<typeof OnboardingStepStatusSchema>
export type OnboardingProfile = z.infer<typeof OnboardingProfileSchema>
export type InstallerStageStatus = z.infer<typeof InstallerStageStatusSchema>
export type InstallerStage = z.infer<typeof InstallerStageSchema>
export type InstallerStageEvent = z.infer<typeof InstallerStageEventSchema>
export type LegacyDetection = z.infer<typeof LegacyDetectionSchema>
export type OnboardingTierModel = z.infer<typeof OnboardingTierModelSchema>
export type OnboardingTiers = z.infer<typeof OnboardingTiersSchema>
export type ByokProvider = z.infer<typeof ByokProviderSchema>
export type OnboardingStatus = z.infer<typeof OnboardingStatusSchema>
export type MigrationChoiceRequest = z.infer<typeof MigrationChoiceRequestSchema>
export type ByokTestRequest = z.infer<typeof ByokTestRequestSchema>
export type ByokTestResponse = z.infer<typeof ByokTestResponseSchema>
export type ByokApplyRequest = z.infer<typeof ByokApplyRequestSchema>
export type ModelsApplyRequest = z.infer<typeof ModelsApplyRequestSchema>
export type FirstSpaceRequest = z.infer<typeof FirstSpaceRequestSchema>
export type GmailIntegrationRequest = z.infer<typeof GmailIntegrationRequestSchema>
export type CalendarIntegrationRequest = z.infer<typeof CalendarIntegrationRequestSchema>
export type CalendarIntegrationRequestInput = z.input<typeof CalendarIntegrationRequestSchema>
export type IntegrationsApplyRequest = z.infer<typeof IntegrationsApplyRequestSchema>
export type FinishResponse = z.infer<typeof FinishResponseSchema>
