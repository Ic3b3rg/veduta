import {
  FinishResponseSchema,
  ImportApplyResponseSchema,
  ImportPlanSchema,
  OnboardingStatusSchema,
  type FinishResponse,
  type FirstSpaceRequest,
  type ImportApplyRequest,
  type ImportApplyResponse,
  type ImportPlan,
  type ImportPreviewRequest,
  type IntegrationsApplyRequest,
  type MigrationChoiceRequest,
  type ModelConnectionStepRequest,
  type OnboardingStatus,
} from '@veduta/protocol'
import { getJson, postJson } from './api-http.ts'

export async function fetchOnboardingStatus(token?: string): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await getJson('/api/onboarding', token))
}

export async function submitMigrationChoice(
  choice: MigrationChoiceRequest['choice'],
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(
    await postJson('/api/onboarding/migration', { choice }, token),
  )
}

export async function previewLegacyImport(
  request: ImportPreviewRequest,
  token?: string,
): Promise<ImportPlan> {
  return ImportPlanSchema.parse(await postJson('/api/onboarding/migration/preview', request, token))
}

export async function runLegacyImport(
  request: ImportApplyRequest,
  token?: string,
): Promise<ImportApplyResponse> {
  return ImportApplyResponseSchema.parse(
    await postJson('/api/onboarding/migration/import', request, token),
  )
}

export async function confirmDomainStep(token?: string): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await postJson('/api/onboarding/domain', {}, token))
}

export async function applyModelConnectionStep(
  request: ModelConnectionStepRequest,
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(
    await postJson('/api/onboarding/model-connection', request, token),
  )
}

export async function applyFirstSpaceStep(
  request: FirstSpaceRequest,
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(await postJson('/api/onboarding/first-space', request, token))
}

export async function applyIntegrationsStep(
  request: IntegrationsApplyRequest,
  token?: string,
): Promise<OnboardingStatus> {
  return OnboardingStatusSchema.parse(
    await postJson('/api/onboarding/integrations', request, token),
  )
}

export async function finishOnboarding(token?: string): Promise<FinishResponse> {
  return FinishResponseSchema.parse(await postJson('/api/onboarding/finish', {}, token))
}
