import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { AuthDevice, AuthState, PersistedPasskey, PersistedSession } from './auth-store.ts'

const PersistedPasskeySchema = z.object({
  id: z.string().min(1),
  publicKey: z.string().min(1),
  counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(),
  deviceType: z.string().min(1),
  backedUp: z.boolean(),
  webAuthnUserID: z.string().min(1),
  deviceId: z.string().min(1),
  createdAt: z.string().datetime(),
  revokedAt: z.string().datetime().optional(),
})

const AuthDeviceFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  credentialId: z.string().min(1),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
})

const PersistedSessionSchema = z.object({
  id: z.string().min(1),
  tokenHash: z.string().min(1),
  deviceId: z.string().min(1),
  scopes: z.tuple([z.literal('gateway')]),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  lastSeenAt: z.string().datetime().optional(),
  revokedAt: z.string().datetime().optional(),
})

const AuthStateFileSchema = z.object({
  bootstrapCodeHash: z.string().optional(),
  passkeys: z.array(PersistedPasskeySchema),
  devices: z.array(AuthDeviceFileSchema),
  sessions: z.array(PersistedSessionSchema),
})

export function loadAuthState(path: string): AuthState | undefined {
  try {
    const parsed = AuthStateFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    const state: AuthState = {
      passkeys: parsed.passkeys.map(toPersistedPasskey),
      devices: parsed.devices.map(toAuthDevice),
      sessions: parsed.sessions.map(toPersistedSession),
    }
    if (parsed.bootstrapCodeHash !== undefined) state.bootstrapCodeHash = parsed.bootstrapCodeHash
    return state
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
}

function toPersistedPasskey(input: z.infer<typeof PersistedPasskeySchema>): PersistedPasskey {
  const passkey: PersistedPasskey = {
    id: input.id,
    publicKey: input.publicKey,
    counter: input.counter,
    deviceType: input.deviceType,
    backedUp: input.backedUp,
    webAuthnUserID: input.webAuthnUserID,
    deviceId: input.deviceId,
    createdAt: input.createdAt,
  }
  if (input.transports !== undefined) passkey.transports = input.transports
  if (input.revokedAt !== undefined) passkey.revokedAt = input.revokedAt
  return passkey
}

function toAuthDevice(input: z.infer<typeof AuthDeviceFileSchema>): AuthDevice {
  const device: AuthDevice = {
    id: input.id,
    name: input.name,
    credentialId: input.credentialId,
    createdAt: input.createdAt,
  }
  if (input.lastSeenAt !== undefined) device.lastSeenAt = input.lastSeenAt
  if (input.revokedAt !== undefined) device.revokedAt = input.revokedAt
  return device
}

function toPersistedSession(input: z.infer<typeof PersistedSessionSchema>): PersistedSession {
  const session: PersistedSession = {
    id: input.id,
    tokenHash: input.tokenHash,
    deviceId: input.deviceId,
    scopes: input.scopes,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  }
  if (input.lastSeenAt !== undefined) session.lastSeenAt = input.lastSeenAt
  if (input.revokedAt !== undefined) session.revokedAt = input.revokedAt
  return session
}

export function saveAuthState(path: string, state: AuthState): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(AuthStateFileSchema.parse(state), null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
