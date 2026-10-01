import { z } from 'zod'

const ImapServerSchema = z
  .string()
  .url()
  .refine((url) => {
    const parsed = new URL(url)
    return parsed.protocol === 'imaps:' || parsed.protocol === 'imap:'
  })
const SmtpServerSchema = z
  .string()
  .url()
  .refine((url) => {
    const parsed = new URL(url)
    return parsed.protocol === 'smtps:' || parsed.protocol === 'smtp:'
  })

export const HimalayaConnectionSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(100),
    address: z.string().email().optional(),
    imapServer: ImapServerSchema,
    smtpServer: SmtpServerSchema.optional(),
    state: z.enum(['needs_smtp', 'needs_verification', 'needs_setup', 'ready', 'failed']),
    reason: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict()
export type HimalayaConnection = z.infer<typeof HimalayaConnectionSchema>

export const HimalayaConnectionsSnapshotSchema = z
  .object({ connections: z.array(HimalayaConnectionSchema) })
  .strict()
export type HimalayaConnectionsSnapshot = z.infer<typeof HimalayaConnectionsSnapshotSchema>

export const CreateHimalayaConnectionRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.string().email(),
    imapServer: ImapServerSchema,
    imapUsername: z.string().min(1),
    imapPassword: z.string().min(1),
    smtpServer: SmtpServerSchema,
    smtpUsername: z.string().min(1),
    smtpPassword: z.string().min(1),
  })
  .strict()
export type CreateHimalayaConnectionRequest = z.infer<typeof CreateHimalayaConnectionRequestSchema>

export const CompleteLegacyHimalayaRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    address: z.string().email(),
    smtpServer: SmtpServerSchema,
    smtpUsername: z.string().min(1),
    smtpPassword: z.string().min(1),
  })
  .strict()
