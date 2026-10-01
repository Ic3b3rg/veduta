import { z } from 'zod'

export const ServiceKindSchema = z.enum(['gmail', 'github'])
export type ServiceKind = z.infer<typeof ServiceKindSchema>

export const ConnectionAttemptStateSchema = z.enum([
  'draft',
  'reviewing',
  'authorizing',
  'verifying',
  'ready',
  'cancelled',
  'failed',
  'unsupported',
  'needs_reconnect',
])
export type ConnectionAttemptState = z.infer<typeof ConnectionAttemptStateSchema>

export const ServiceConnectionStateSchema = z.enum([
  'ready',
  'degraded',
  'needs_reconnect',
  'disabled',
  'removed',
])
export type ServiceConnectionState = z.infer<typeof ServiceConnectionStateSchema>

export const ConnectionReviewSchema = z
  .object({
    service: ServiceKindSchema,
    accountHint: z.string().max(240).optional(),
    scopes: z.array(z.string().min(1).max(240)).min(1).max(8),
    actions: z.array(z.string().min(1).max(80)).min(1).max(8),
    executionHost: z.string().min(1).max(240),
    serverVersion: z.string().max(80).optional(),
    serverSource: z.string().url().optional(),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    executableSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    toolSchemaSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    repository: z
      .object({ owner: z.string().min(1), name: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict()
export type ConnectionReview = z.infer<typeof ConnectionReviewSchema>

export const ConnectionAttemptSchema = z
  .object({
    id: z.string().uuid(),
    submissionId: z.string().uuid(),
    turnId: z.string().min(1),
    spaceId: z.string().min(1),
    requestSummary: z.string().min(1).max(700),
    review: ConnectionReviewSchema,
    state: ConnectionAttemptStateSchema,
    reason: z.string().max(400).optional(),
    nextAction: z.string().max(200).optional(),
    connectionId: z.string().min(1).optional(),
    verifiedAccount: z.string().max(240).optional(),
    verifiedScopes: z.array(z.string()).optional(),
    continuation: z.enum(['unclaimed', 'claimed', 'completed']).default('unclaimed'),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type ConnectionAttempt = z.infer<typeof ConnectionAttemptSchema>

export const ServiceConnectionSchema = z
  .object({
    id: z.string().min(1),
    service: ServiceKindSchema,
    mechanism: z.enum(['gmail-oauth', 'github-mcp-stdio']),
    account: z.string().min(1).max(240),
    scopes: z.array(z.string()).min(1),
    executionHost: z.string().min(1),
    authorizationRevision: z.string().uuid(),
    state: ServiceConnectionStateSchema,
    reason: z.string().max(400).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type ServiceConnection = z.infer<typeof ServiceConnectionSchema>

export const SpaceCapabilityGrantSchema = z
  .object({
    id: z.string().uuid(),
    spaceId: z.string().min(1),
    connectionId: z.string().min(1),
    authorizationRevision: z.string().uuid(),
    actions: z.array(z.string().min(1)).min(1),
    repository: z
      .object({ owner: z.string().min(1), name: z.string().min(1) })
      .strict()
      .optional(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type SpaceCapabilityGrant = z.infer<typeof SpaceCapabilityGrantSchema>

export const ServiceConnectionsSnapshotSchema = z
  .object({
    attempts: z.array(ConnectionAttemptSchema),
    connections: z.array(ServiceConnectionSchema),
    grants: z.array(SpaceCapabilityGrantSchema),
  })
  .strict()
export type ServiceConnectionsSnapshot = z.infer<typeof ServiceConnectionsSnapshotSchema>
