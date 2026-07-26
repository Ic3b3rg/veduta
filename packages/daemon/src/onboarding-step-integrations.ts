import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { IntegrationsApplyRequest } from '@veduta/protocol'
import { backupFile } from './config-backup.ts'
import {
  loadIngestionConfig,
  saveIngestionConfig,
  type IngestionSource,
} from './ingestion-config.ts'
import { loadOnboardingConfig, saveOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError, VaultUnavailableError } from './onboarding-status.ts'
import { PreFilterRulesSchema } from './pre-filter.ts'
import { defaultRedactor } from './redaction.ts'
import { VAULT_FILE_NAME, type SecretsVault } from './secrets-vault.ts'

export interface IntegrationsDeps {
  rootDir: string
  vault: SecretsVault | undefined
  domain: string | null
  /** Injectable for tests; defaults to a random 24-byte base64url token. */
  randomToken?: () => string
}

function defaultRandomToken(): string {
  return randomBytes(24).toString('base64url')
}

interface GoogleCredentials {
  clientId: string
  clientSecret?: string | undefined
  refreshToken?: string | undefined
}

/**
 * gmail and calendar are two independent Google Cloud OAuth clients in
 * practice (issue #19 code review fix): they used to share one
 * `google-client-id`/`google-client-secret`/`google-refresh-token` vault
 * entry, so submitting different credentials for the two silently made the
 * second overwrite the first's. Every vault name is namespaced by service
 * instead.
 */
type GoogleServiceKind = 'gmail' | 'calendar'

interface GoogleVaultNames {
  clientId: string
  clientSecret: string
  refreshToken: string
}

function googleVaultNames(kind: GoogleServiceKind): GoogleVaultNames {
  return {
    clientId: `${kind}-client-id`,
    clientSecret: `${kind}-client-secret`,
    refreshToken: `${kind}-refresh-token`,
  }
}

/** Registers every secret-shaped field the request actually carries, before any other processing runs. */
function registerRequestSecrets(request: IntegrationsApplyRequest): void {
  if ('skip' in request) return
  for (const half of [request.gmail, request.calendar]) {
    if (half?.clientSecret !== undefined) defaultRedactor.register(half.clientSecret)
    if (half?.refreshToken !== undefined) defaultRedactor.register(half.refreshToken)
  }
}

/**
 * Writes one service's Google OAuth credentials into the vault under its
 * own namespaced entries (`googleVaultNames`). `clientId` is always
 * (over)written — it is not secret-sensitive but is kept in the vault for
 * uniformity. `clientSecret`/`refreshToken` omitted means "keep the
 * existing stored value"; if nothing is stored yet for THIS service, that is
 * an error naming the missing credential, never echoing any value.
 */
function applyGoogleCredentials(
  vault: SecretsVault,
  kind: GoogleServiceKind,
  creds: GoogleCredentials,
  ensureBackup: () => void,
): void {
  ensureBackup()
  const names = googleVaultNames(kind)
  vault.set(names.clientId, creds.clientId)

  if (creds.clientSecret !== undefined) {
    vault.set(names.clientSecret, creds.clientSecret)
  } else if (!vault.has(names.clientSecret)) {
    throw new OnboardingStepError(
      `missing ${names.clientSecret}: submit clientSecret or complete a prior integrations apply first`,
    )
  }

  if (creds.refreshToken !== undefined) {
    vault.set(names.refreshToken, creds.refreshToken)
  } else if (!vault.has(names.refreshToken)) {
    throw new OnboardingStepError(
      `missing ${names.refreshToken}: submit refreshToken or complete a prior integrations apply first`,
    )
  }
}

/** Generates and stores a channel token once, idempotently — an existing token is never rotated on re-apply. */
function ensureChannelToken(
  vault: SecretsVault,
  vaultName: string,
  randomToken: () => string,
  ensureBackup: () => void,
): void {
  if (vault.has(vaultName)) return
  ensureBackup()
  const token = randomToken()
  defaultRedactor.register(token)
  vault.set(vaultName, token)
}

function googleRefs(kind: GoogleServiceKind): NonNullable<IngestionSource['google']> {
  const names = googleVaultNames(kind)
  return {
    clientIdRef: `secret://vault/${names.clientId}`,
    clientSecretRef: `secret://vault/${names.clientSecret}`,
    refreshTokenRef: `secret://vault/${names.refreshToken}`,
  }
}

/**
 * `POST /api/onboarding/integrations` (`tasks/plan.md` §4/§8). Skip records
 * `skipped` and does nothing else. Otherwise: the first-space step must
 * already be recorded (every source needs a target `spaceId` — reused from
 * `config.firstSpace.spaceId` rather than re-derived, falling back to the
 * `spc-<slug>` scheme only for a config written before that field existed);
 * the vault is backed up once before its first write in this call; each
 * service's Google OAuth credentials are namespaced and support the
 * keep-existing sentinel; a per-source channel token is generated once and
 * never rotated; the resulting `gmail`/`calendar` sources are built on top
 * of whatever `ingestion.json` already has, validated by
 * `saveIngestionConfig`, and only then is the step marked `completed`
 * (side-effects-first, status-last).
 */
export function applyIntegrations(deps: IntegrationsDeps, request: IntegrationsApplyRequest): void {
  registerRequestSecrets(request)

  const config = loadOnboardingConfig(deps.rootDir)

  if ('skip' in request) {
    saveOnboardingConfig(deps.rootDir, {
      ...config,
      steps: { ...config.steps, integrations: 'skipped' },
    })
    return
  }

  if (!config.firstSpace) {
    throw new OnboardingStepError('complete the first-space step before configuring integrations')
  }
  const spaceId = config.firstSpace.spaceId ?? `spc-${config.firstSpace.slug}`

  if (!deps.vault) throw new VaultUnavailableError()
  const vault = deps.vault
  const randomToken = deps.randomToken ?? defaultRandomToken

  let backedUp = false
  const ensureBackup = (): void => {
    if (backedUp) return
    backedUp = true
    backupFile(join(deps.rootDir, VAULT_FILE_NAME))
  }

  const ingestion = loadIngestionConfig(deps.rootDir)
  const sources: Record<string, IngestionSource> = { ...ingestion.sources }

  if (request.gmail) {
    applyGoogleCredentials(vault, 'gmail', request.gmail, ensureBackup)
    ensureChannelToken(vault, 'ingest-gmail-token', randomToken, ensureBackup)
    sources.gmail = {
      verification: 'channel-token',
      secret: 'secret://vault/ingest-gmail-token',
      spaceId,
      adapter: 'gmail-push',
      ratePerMinute: 60,
      filters: PreFilterRulesSchema.parse({}),
      gmail: {
        topicName: request.gmail.topicName,
        subscription: request.gmail.subscription,
      },
      google: googleRefs('gmail'),
    }
  }

  if (request.calendar) {
    applyGoogleCredentials(vault, 'calendar', request.calendar, ensureBackup)
    ensureChannelToken(vault, 'ingest-calendar-token', randomToken, ensureBackup)
    const address = deps.domain
      ? `https://${deps.domain}/api/ingest/calendar`
      : 'http://127.0.0.1:8787/api/ingest/calendar'
    sources.calendar = {
      verification: 'channel-token',
      secret: 'secret://vault/ingest-calendar-token',
      spaceId,
      adapter: 'calendar-push',
      ratePerMinute: 60,
      filters: PreFilterRulesSchema.parse({}),
      calendar: { calendarId: request.calendar.calendarId, address },
      google: googleRefs('calendar'),
    }
  }

  saveIngestionConfig(deps.rootDir, { sources })

  saveOnboardingConfig(deps.rootDir, {
    ...config,
    steps: { ...config.steps, integrations: 'completed' },
  })
}
