import { z } from 'zod'

export const AuthModeSchema = z.enum(['dev', 'production'])

export const AuthStatusSchema = z.object({
  mode: AuthModeSchema,
  passkeyRegistered: z.boolean(),
  bootstrapRequired: z.boolean(),
})

export const AuthDeviceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  credentialId: z.string().min(1),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
})

export const AuthSessionTokenSchema = z.string().regex(/^vdt_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/)

export const AuthSessionSchema = z.object({
  token: AuthSessionTokenSchema,
  device: AuthDeviceSchema,
})

export const OneTimeCodeSchema = z.string().min(6).max(64)

export const PairingCodeSchema = z.object({
  code: OneTimeCodeSchema,
  expiresAt: z.string().datetime(),
  pairingUri: z.string().url(),
})

export const WebAuthnOptionsEnvelopeSchema = z.object({
  ceremonyId: z.string().min(1),
  options: z.unknown(),
})

export type AuthMode = z.infer<typeof AuthModeSchema>
export type AuthStatus = z.infer<typeof AuthStatusSchema>
export type AuthDevice = z.infer<typeof AuthDeviceSchema>
export type AuthSession = z.infer<typeof AuthSessionSchema>
export type PairingCode = z.infer<typeof PairingCodeSchema>
export type WebAuthnOptionsEnvelope = z.infer<typeof WebAuthnOptionsEnvelopeSchema>
