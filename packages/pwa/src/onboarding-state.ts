import type {
  ByokProvider,
  OnboardingStatus,
  OnboardingStepId,
  OnboardingTiers,
} from '@veduta/protocol'

/**
 * Pure presentation logic for the onboarding wizard (issue 019,
 * `tasks/plan.md` "Design decisions (v2)" §3-4): step metadata/copy, resume
 * (current step + progress indicator), and small read-only helpers over
 * `OnboardingStatus`. No DOM access at module scope, no fetch — the wizard
 * shell (`onboarding-wizard.tsx`, T6) is the only caller that touches the
 * network, following the `home-state.ts` / `notification-onboarding.ts`
 * convention of keeping wizard logic unit-testable without a browser.
 */

export interface OnboardingStepMeta {
  title: string
  description: string
}

/**
 * User-facing copy per step. Hermes discipline (`docs/references/04-onboarding-migration.md`
 * §C "to copy"): every dead end prints the exact next command, current
 * values are honestly described, nothing is oversold.
 */
export const WIZARD_STEP_META: Record<OnboardingStepId, OnboardingStepMeta> = {
  migration: {
    title: 'Existing installation',
    description:
      'An existing OpenClaw/Hermes installation was detected. Preview what would be imported ' +
      'before anything is written -- facts, SOUL and USER content, and what would be skipped or ' +
      'overwritten -- then apply it, or defer and configure manually instead. Provider API keys ' +
      'are never imported here; that stays a CLI-only, explicit step.',
  },
  domain: {
    title: 'Domain',
    description:
      'Confirm the domain and TLS certificate detected for this installation. To change the ' +
      'domain later: sudo systemctl edit veduta, override VEDUTA_PUBLIC_DOMAIN in the drop-in, ' +
      'then sudo systemctl restart veduta.',
  },
  byok: {
    title: 'Bring your own key',
    description:
      'Add an API key for Anthropic, OpenAI, or OpenRouter so the daemon can reason with a ' +
      'real model. Skipping is fine: without a key the daemon serves the built-in mock ' +
      'provider; add a key later with: pnpm --filter @veduta/daemon vault set <provider> <key> ' +
      '--root <data dir>.',
  },
  models: {
    title: 'Models',
    description:
      'Choose which models handle each tier: triage is a cheap, fast model used for quick ' +
      'classification; reasoning is a stronger model used for chat turns and heartbeat ' +
      'reasoning. Sensible defaults are pre-selected.',
  },
  'first-space': {
    title: 'First Space',
    description:
      'A Space is one life area — a persistent place the agent maintains for you (e.g. ' +
      '"Health", "Home", "Finances"). Create your first one to get started; you can add more ' +
      'later.',
  },
  integrations: {
    title: 'Integrations',
    description:
      'Optionally connect Gmail and/or Calendar so the agent can react to what arrives there. ' +
      'This is optional and can be skipped. To connect: 1) open ' +
      'https://console.cloud.google.com and create or select a project; 2) enable the Gmail ' +
      'API and/or Calendar API; 3) create an OAuth client (type: Web); 4) obtain a refresh ' +
      'token for that client. Gmail push additionally needs a Pub/Sub topic and subscription: ' +
      'gcloud pubsub topics create <topic>, then gcloud pubsub subscriptions create <sub> ' +
      '--topic <topic> --push-endpoint=https://<domain>/api/ingest/gmail, and grant publish ' +
      'rights on the topic to gmail-api-push@system.gserviceaccount.com. Connected sources ' +
      'activate after the daemon restarts.',
  },
  finish: {
    title: 'Finish',
    description: 'Applying configuration. The daemon saves everything and restarts to pick it up.',
  },
}

/** The steps to render, in the order the daemon reports them (`status.steps`). */
export function visibleSteps(status: OnboardingStatus): OnboardingStepId[] {
  return status.steps.map((step) => step.id)
}

/**
 * The step to show right now. Trusts `status.currentStep` when the daemon
 * supplies one; otherwise falls back to the first `pending` step in
 * `status.steps` order (resume = first incomplete step, `tasks/plan.md` §2).
 * `null` when every step is done (or there are no steps at all).
 */
export function currentStep(status: OnboardingStatus): OnboardingStepId | null {
  if (status.currentStep !== null) return status.currentStep
  const firstPending = status.steps.find((step) => step.status === 'pending')
  return firstPending ? firstPending.id : null
}

/** 1-based position of the active step among the visible steps, and the total count. */
export function stepIndicator(status: OnboardingStatus): { index: number; total: number } {
  const steps = visibleSteps(status)
  const active = currentStep(status)
  const position = active === null ? -1 : steps.indexOf(active)
  return { index: position < 0 ? steps.length : position + 1, total: steps.length }
}

/** Whether a given step is already `completed` or `skipped` (i.e. not pending). */
export function isStepDone(status: OnboardingStatus, id: OnboardingStepId): boolean {
  const step = status.steps.find((candidate) => candidate.id === id)
  return step !== undefined && step.status !== 'pending'
}

/**
 * Whether the BYOK step can offer "keep existing key" for a provider — the
 * keep-existing sentinel (`tasks/plan.md` §4/§7) only makes sense when the
 * vault already has a key stored for it.
 */
export function byokKeepExistingAvailable(
  status: OnboardingStatus,
  provider: ByokProvider,
): boolean {
  return status.byok.providers.some((entry) => entry.provider === provider && entry.hasKey)
}

/** Pass-through of the daemon's current tier assignments, pre-filled as the models step's defaults. */
export function defaultTierSelections(status: OnboardingStatus): OnboardingTiers {
  return status.models.tiers
}
