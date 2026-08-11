import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  InstallerStageEventSchema,
  type InstallerStageEvent,
  type LegacyDetection,
  type OnboardingStatus,
  type OnboardingStepId,
  type Space,
} from '@veduta/protocol'
import { loadConnectionsConfig } from './connections-config.ts'
import { OPENCLAW_ALIASES } from './import-source.ts'
import { loadIngestionConfig } from './ingestion-config.ts'
import { loadOnboardingConfig } from './onboarding-config.ts'
import type { SecretsVault } from './secrets-vault.ts'

/**
 * The wizard's canonical step order. `migration` is filtered out of the *visible* set by
 * `buildOnboardingStatus` when no legacy install is detected — this array
 * itself always lists every step so callers have one source of truth for
 * ordering. `byok`/`models` collapsed into the single `model-connection` step
 * (issue #47, `docs/adr/0014-subscription-inference-boundary.md`).
 */
export const ONBOARDING_STEP_ORDER: OnboardingStepId[] = [
  'migration',
  'domain',
  'model-connection',
  'first-space',
  'integrations',
  'finish',
]

/**
 * Scans `home` for a legacy Hermes/OpenClaw install (`~/.hermes`,
 * `~/.openclaw`, or either of OpenClaw's former names `~/.clawdbot`/
 * `~/.moltbot`). Used by the daemon only as a loopback-profile fallback
 * (`VEDUTA_LEGACY_HOME`, verification per ADR-0009); on a real VPS install
 * the daemon runs as `veduta` under `ProtectHome=yes` and can never see the
 * admin's real home — that detection happens in the installer's
 * legacy-detect stage and is persisted into `onboarding.json.legacy` before
 * the daemon ever boots, which is why
 * `buildOnboardingStatus` always prefers the persisted value over calling
 * this function again.
 *
 * Imports `OPENCLAW_ALIASES` from `import-source.ts`
 * instead of keeping a second, independently-maintained copy of OpenClaw's
 * former names — the two had drifted into two TypeScript lists doing the
 * same job. `deploy/install.sh`'s own copy is the one duplication left,
 * since bash cannot import a TypeScript constant.
 */
export function detectLegacyAgents(home: string): LegacyDetection {
  const openclaw = OPENCLAW_ALIASES.some((alias) => existsSync(join(home, alias)))
  const hermes = existsSync(join(home, '.hermes'))
  return {
    openclaw,
    hermes,
    ...(openclaw || hermes ? { sourceHome: home } : {}),
  }
}

/**
 * Dead-end copy shared by every step module that needs the vault and finds
 * none open, and by the importer (`import-apply.ts`) when it needs vault
 * key material for a backup: the exact
 * commands to provision a keyfile. Exported as a standalone constant (rather
 * than only living inside `VaultUnavailableError`'s message) so a second
 * caller can quote the identical text without constructing this error type
 * — `import-apply.ts` throws its own `ImportRefusedError` with this same
 * message, since the importer's refusal has its own `blocked` list shape.
 * Routes map `VaultUnavailableError` to a 409; neither this constant
 * nor the error is ever built with any secret value attached.
 */
export const VAULT_UNAVAILABLE_MESSAGE = [
  'no secrets vault is available: this daemon booted with no vault key material.',
  'Generate a keyfile and restart:',
  '  sudo install -d -m 0755 /etc/veduta',
  '  head -c 48 /dev/urandom | base64 | sudo tee /etc/veduta/vault.key > /dev/null',
  '  sudo chown veduta:veduta /etc/veduta/vault.key',
  '  sudo chmod 0400 /etc/veduta/vault.key',
  'then set VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key (see deploy/README.md §2).',
].join('\n')

export class VaultUnavailableError extends Error {
  constructor() {
    super(VAULT_UNAVAILABLE_MESSAGE)
    this.name = 'VaultUnavailableError'
  }
}

/**
 * A user-facing onboarding step failure. Step modules
 * throw this instead of a plain `Error` for anything the caller did wrong
 * (missing credential, first-space-before-integrations, an empty slug, a
 * finish attempted before every prior step is done, no stored key to
 * fall back on) so `onboarding-routes.ts` can map it to the right HTTP
 * status without guessing from an `Error`'s class. `statusCode` defaults to
 * 400; `applyFinish`'s completion gate sets 409 (same code as
 * `VaultUnavailableError`: "fix something first, then retry").
 */
export class OnboardingStepError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'OnboardingStepError'
  }
}

/**
 * Legacy detection this run should use: the installer-persisted value
 * (`onboarding.json.legacy`, set before the daemon's first boot on a real
 * VPS install) always wins over live detection — see `detectLegacyAgents`'s
 * doc comment for why the daemon itself can usually never see the admin's
 * real home. Shared by `buildOnboardingStatus` and `applyFinish`'s
 * completion gate so both agree on exactly the same migration-visibility
 * rule.
 */
export function resolveLegacy(
  rootDir: string,
  env: NodeJS.ProcessEnv,
  homeDir?: string,
): LegacyDetection {
  const config = loadOnboardingConfig(rootDir)
  return config.legacy ?? detectLegacyAgents(env['VEDUTA_LEGACY_HOME'] ?? homeDir ?? homedir())
}

/**
 * The step ids actually shown to the user this run: `migration` only when a
 * legacy install was detected (`ONBOARDING_STEP_ORDER` always lists every
 * step; this is the one filter that turns that into what the wizard — and
 * `applyFinish`'s completion gate — actually walks).
 */
export function visibleOnboardingStepIds(legacy: LegacyDetection): OnboardingStepId[] {
  return ONBOARDING_STEP_ORDER.filter(
    (id) => id !== 'migration' || legacy.openclaw || legacy.hermes,
  )
}

export interface OnboardingStatusDeps {
  rootDir: string
  profile: 'loopback' | 'local-vps' | 'vps'
  domain: string | null
  tlsActive: boolean
  vault?: SecretsVault
  listSpaces(): Space[]
  env: NodeJS.ProcessEnv
  homeDir?: string
}

/**
 * Reads `<rootDir>/installer-stages.json` if present.
 * A missing file, unparseable JSON, or a payload that fails
 * `InstallerStageEventSchema` are all treated the same way: no installer
 * summary is surfaced. The wizard must still work end-to-end when the
 * installer never ran (a hand-rolled or `pnpm dev` loopback install).
 */
function readInstallerSummary(rootDir: string): InstallerStageEvent | undefined {
  const path = join(rootDir, 'installer-stages.json')
  if (!existsSync(path)) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
  const parsed = InstallerStageEventSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

/**
 * Assembles `GET /api/onboarding`'s response: the
 * single source of truth for resuming the wizard and for pre-filling every
 * step's form with current values. Never returns a secret value, only
 * `hasKey`/`hasCredentials` booleans.
 */
export function buildOnboardingStatus(deps: OnboardingStatusDeps): OnboardingStatus {
  const config = loadOnboardingConfig(deps.rootDir)
  const legacy =
    config.legacy ?? detectLegacyAgents(deps.env['VEDUTA_LEGACY_HOME'] ?? deps.homeDir ?? homedir())

  const visibleStepIds = visibleOnboardingStepIds(legacy)
  const steps = visibleStepIds.map((id) => ({
    id,
    status: config.steps[id] ?? 'pending',
  }))
  const completed = (config.steps.finish ?? 'pending') === 'completed'
  const currentStep =
    steps.find((step) => step.status !== 'completed' && step.status !== 'skipped')?.id ?? null
  // 'vps' and 'local-vps' both run real passkey auth (issue 023) and so both
  // require the wizard the same way; they differ only in supervisor and
  // copy, not in whether onboarding is required.
  const required =
    !completed &&
    (deps.profile === 'vps' ||
      deps.profile === 'local-vps' ||
      deps.env['VEDUTA_ONBOARDING'] === 'force')

  const installer = readInstallerSummary(deps.rootDir)

  const connectionsFile = loadConnectionsConfig(deps.rootDir)
  const ingestion = loadIngestionConfig(deps.rootDir)

  const existingSpaces = deps
    .listSpaces()
    .filter((space) => !space.archived)
    .map((space) => ({ id: space.id, slug: space.slug, name: space.name }))

  const gmailClientId = deps.vault?.resolve('secret://vault/gmail-client-id')
  const calendarClientId = deps.vault?.resolve('secret://vault/calendar-client-id')
  const gmailSource = ingestion.sources['gmail']
  const calendarSource = ingestion.sources['calendar']

  return {
    required,
    completed,
    profile: deps.profile,
    currentStep,
    steps,
    legacy,
    ...(installer === undefined ? {} : { installer }),
    domain: { domain: deps.domain, tlsActive: deps.tlsActive },
    // The `model-connection` step's resume state (issue #47, replacing the
    // old `byok`/`models` fields): a plain count and booleans, computed
    // directly from `connections.json` — no injected dependency, the same
    // "read the config file directly" style `loadRoutingConfig`/
    // `loadIngestionConfig` already use just above.
    modelConnection: {
      vaultAvailable: deps.vault !== undefined,
      connectedCount: connectionsFile.connections.filter(
        (connection) => connection.state === 'connected',
      ).length,
      hasSelection: connectionsFile.selection !== undefined,
      mockEnabled: connectionsFile.mockEnabled,
    },
    firstSpace: {
      suggestedName: config.firstSpace?.name ?? 'Personal',
      existingSpaces,
    },
    integrations: {
      gmail: {
        configured: gmailSource !== undefined,
        hasCredentials: hasGoogleCredentials(deps.vault, 'gmail'),
        ...(gmailClientId === undefined ? {} : { clientId: gmailClientId }),
        ...(gmailSource?.gmail?.topicName === undefined
          ? {}
          : { topicName: gmailSource.gmail.topicName }),
        ...(gmailSource?.gmail?.subscription === undefined
          ? {}
          : { subscription: gmailSource.gmail.subscription }),
      },
      calendar: {
        configured: calendarSource !== undefined,
        hasCredentials: hasGoogleCredentials(deps.vault, 'calendar'),
        ...(calendarClientId === undefined ? {} : { clientId: calendarClientId }),
        ...(calendarSource?.calendar?.calendarId === undefined
          ? {}
          : { calendarId: calendarSource.calendar.calendarId }),
      },
    },
  }
}

/**
 * Per-source Google OAuth credential presence. Gmail and
 * calendar each get their own `<kind>-client-id`/`<kind>-client-secret`/
 * `<kind>-refresh-token` vault entries (`onboarding-step-integrations.ts`)
 * so submitting different OAuth clients for the two no longer makes one
 * silently overwrite the other's stored credentials.
 */
function hasGoogleCredentials(
  vault: SecretsVault | undefined,
  kind: 'gmail' | 'calendar',
): boolean {
  return (
    (vault?.has(`${kind}-client-id`) ?? false) &&
    (vault?.has(`${kind}-client-secret`) ?? false) &&
    (vault?.has(`${kind}-refresh-token`) ?? false)
  )
}
