export { ActionSchema, type Action, type ActionInput } from './action.ts'
export { applySurfacePatch, applySurfacePatchEvent } from './apply-patch.ts'
export {
  AuthDeviceSchema,
  AuthModeSchema,
  AuthSessionSchema,
  AuthSessionTokenSchema,
  AuthStatusSchema,
  OneTimeCodeSchema,
  PairingCodeSchema,
  WebAuthnOptionsEnvelopeSchema,
  type AuthDevice,
  type AuthMode,
  type AuthSession,
  type AuthStatus,
  type PairingCode,
  type WebAuthnOptionsEnvelope,
} from './auth.ts'
export { atomTypes, AtomTypeSchema, AtomNodeSchema, type AtomType, type AtomNode } from './atom.ts'
export {
  SurfaceSchema,
  FreshnessSchema,
  SurfaceValidationError,
  parseSurface,
  formatSurfaceIssues,
  type Surface,
  type Freshness,
} from './surface.ts'
export { SpaceSchema, type Space } from './space.ts'
export {
  PatchSchema,
  PatchOperationSchema,
  ActionInvocationSchema,
  type Patch,
  type PatchOperation,
  type ActionInvocation,
} from './patch.ts'
export {
  JsonValueSchema,
  JsonObjectSchema,
  type JsonPrimitive,
  type JsonValue,
  type JsonObject,
} from './json.ts'
export {
  ChatMessageSchema,
  ChatClientMessageSchema,
  type ChatMessage,
  type ChatClientMessage,
} from './chat.ts'
export {
  GatewayCursorSchema,
  SpaceWithSurfacesSchema,
  SurfaceSnapshotSchema,
  SurfacePatchEventSchema,
  SurfaceCreatedEventSchema,
  SurfaceArchivedEventSchema,
  PresenceStatusSchema,
  PresenceEntrySchema,
  ApprovalCardSchema,
  GatewayClientMessageSchema,
  GatewayServerMessageSchema,
  type GatewayCursor,
  type SpaceWithSurfaces,
  type SurfaceSnapshot,
  type SurfacePatchEvent,
  type SurfaceCreatedEvent,
  type SurfaceArchivedEvent,
  type PresenceStatus,
  type PresenceEntry,
  type ApprovalCard,
  type GatewayClientMessage,
  type GatewayServerMessage,
} from './gateway.ts'
export {
  findAtom,
  findDeclaredAction,
  findDeclaredFastAction,
  findDeclaredAgentAction,
} from './tree.ts'
export {
  PushSubscriptionSchema,
  PushPayloadSchema,
  type PushSubscription,
  type PushPayload,
} from './notification.ts'
// Onboarding wizard protocol (issue 019): step ids/status, installer JSON stage
// protocol, legacy detection, and every request/response schema for
// `/api/onboarding/*` (see `tasks/plan.md` "Design decisions (v2)" §3-4 and
// `docs/references/04-onboarding-migration.md`).
export {
  OnboardingStepIdSchema,
  OnboardingStepStatusSchema,
  OnboardingProfileSchema,
  InstallerStageStatusSchema,
  InstallerStageSchema,
  InstallerStageEventSchema,
  LegacyDetectionSchema,
  OnboardingTierModelSchema,
  OnboardingTiersSchema,
  ByokProviderSchema,
  OnboardingStatusSchema,
  MigrationChoiceRequestSchema,
  ByokTestRequestSchema,
  ByokTestResponseSchema,
  ByokApplyRequestSchema,
  ModelsApplyRequestSchema,
  FirstSpaceRequestSchema,
  GmailIntegrationRequestSchema,
  CalendarIntegrationRequestSchema,
  IntegrationsApplyRequestSchema,
  FinishResponseSchema,
  type OnboardingStepId,
  type OnboardingStepStatus,
  type OnboardingProfile,
  type InstallerStageStatus,
  type InstallerStage,
  type InstallerStageEvent,
  type LegacyDetection,
  type OnboardingTierModel,
  type OnboardingTiers,
  type ByokProvider,
  type OnboardingStatus,
  type MigrationChoiceRequest,
  type ByokTestRequest,
  type ByokTestResponse,
  type ByokApplyRequest,
  type ModelsApplyRequest,
  type FirstSpaceRequest,
  type GmailIntegrationRequest,
  type CalendarIntegrationRequest,
  type CalendarIntegrationRequestInput,
  type IntegrationsApplyRequest,
  type FinishResponse,
} from './onboarding.ts'
// Importer wire protocol (issue 020): plan/result schemas shared by the CLI's
// text preview and the wizard's rendered preview, and the two
// `/api/onboarding/migration/*` request/response bodies (see `tasks/plan.md`
// design decision 20 and "Wire API").
export {
  ImportSourceKindSchema,
  ImportActionSchema,
  ImportItemSchema,
  ImportOptionsSchema,
  ImportPlanSchema,
  ImportFactCountsSchema,
  ImportResultSchema,
  ImportPreviewRequestSchema,
  ImportApplyRequestSchema,
  ImportApplyResponseSchema,
  type ImportSourceKind,
  type ImportAction,
  type ImportItem,
  type ImportOptions,
  type ImportOptionsInput,
  type ImportPlan,
  type ImportFactCounts,
  type ImportResult,
  type ImportPreviewRequest,
  type ImportPreviewRequestInput,
  type ImportApplyRequest,
  type ImportApplyRequestInput,
  type ImportApplyResponse,
} from './import.ts'
