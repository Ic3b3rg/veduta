import {
  AuthSessionSchema,
  AuthStatusSchema,
  WebAuthnOptionsEnvelopeSchema,
  type AuthSession,
  type AuthStatus,
} from '@veduta/protocol'
import {
  startAuthentication,
  startRegistration,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/browser'
import { postJson } from './api-http.ts'

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const response = await fetch('/api/auth/status')
  if (!response.ok) throw new Error(`GET /api/auth/status failed: ${response.status}`)
  return AuthStatusSchema.parse(await response.json())
}

export async function registerPasskey(input: {
  oneTimeCode: string
  deviceName: string
}): Promise<AuthSession> {
  const envelope = WebAuthnOptionsEnvelopeSchema.parse(
    await postJson('/api/auth/register/options', input),
  )
  const response = await startRegistration({
    optionsJSON: envelope.options as PublicKeyCredentialCreationOptionsJSON,
  })
  return verifyRegistration(envelope.ceremonyId, response)
}

export async function loginWithPasskey(deviceName: string): Promise<AuthSession> {
  const envelope = WebAuthnOptionsEnvelopeSchema.parse(
    await postJson('/api/auth/login/options', {}),
  )
  const response = await startAuthentication({
    optionsJSON: envelope.options as PublicKeyCredentialRequestOptionsJSON,
  })
  return verifyLogin(envelope.ceremonyId, response, deviceName)
}

async function verifyRegistration(
  ceremonyId: string,
  response: RegistrationResponseJSON,
): Promise<AuthSession> {
  return AuthSessionSchema.parse(
    await postJson('/api/auth/register/verify', { ceremonyId, response }),
  )
}

async function verifyLogin(
  ceremonyId: string,
  response: AuthenticationResponseJSON,
  deviceName: string,
): Promise<AuthSession> {
  return AuthSessionSchema.parse(
    await postJson('/api/auth/login/verify', { ceremonyId, response, deviceName }),
  )
}
