import { z } from 'zod'

export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export const GmailConnectionSchema = z
  .object({
    id: z.string().regex(/^svc-gmail-[a-z0-9-]+$/),
    name: z.string().trim().min(1).max(80),
    accountEmail: z.string().email().optional(),
    state: z.enum([
      'needs_credentials',
      'needs_authorization',
      'authorizing',
      'verifying',
      'ready',
      'failed',
    ]),
    reason: z.string().max(240).optional(),
    scopes: z.array(z.literal(GMAIL_READ_SCOPE)),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()

export const GmailConnectionsSnapshotSchema = z
  .object({
    connections: z.array(GmailConnectionSchema),
    oauthClient: z.object({ configured: z.boolean() }).strict().optional(),
  })
  .strict()

export const ConfigureGmailOAuthClientRequestSchema = z
  .object({
    clientId: z.string().trim().min(1).max(500),
    clientSecret: z.string().min(1).max(2000),
  })
  .strict()

export const CreateGmailConnectionRequestSchema = z.union([
  z.object({ name: GmailConnectionSchema.shape.name }).strict(),
  ConfigureGmailOAuthClientRequestSchema.extend({ name: GmailConnectionSchema.shape.name }),
])

export const BeginGmailAuthorizationRequestSchema = z
  .object({ redirectOrigin: z.string().url() })
  .strict()

export const BeginGmailAuthorizationResponseSchema = z
  .object({ authorizationUrl: z.string().url() })
  .strict()

export const CompleteGmailAuthorizationRequestSchema = z
  .object({ code: z.string().min(1).max(4000), state: z.string().min(1).max(4000) })
  .strict()

export const FailGmailAuthorizationRequestSchema = z
  .object({ state: z.string().min(1).max(4000), reason: z.enum(['access_denied', 'other']) })
  .strict()

export const RenameGmailConnectionRequestSchema = z
  .object({ name: GmailConnectionSchema.shape.name })
  .strict()

export type GmailConnection = z.infer<typeof GmailConnectionSchema>
export type GmailConnectionsSnapshot = z.infer<typeof GmailConnectionsSnapshotSchema>
export type CreateGmailConnectionRequest = z.infer<typeof CreateGmailConnectionRequestSchema>
export type ConfigureGmailOAuthClientRequest = z.infer<
  typeof ConfigureGmailOAuthClientRequestSchema
>
