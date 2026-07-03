import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type WebAuthnCredential,
} from '@simplewebauthn/server'
import type { PasskeyOptions, PasskeyRelyingParty, StoredPasskey } from './auth-store.ts'

export interface WebAuthnRelyingPartyOptions {
  rpName: string
  rpID: string
  origin: string
}

export class SimpleWebAuthnRelyingParty implements PasskeyRelyingParty {
  constructor(private readonly options: WebAuthnRelyingPartyOptions) {}

  async generateRegistrationOptions(input: {
    userId: string
    userName: string
    excludeCredentialIds: string[]
  }): Promise<PasskeyOptions> {
    return generateRegistrationOptions({
      rpName: this.options.rpName,
      rpID: this.options.rpID,
      userName: input.userName,
      userID: Buffer.from(input.userId),
      attestationType: 'none',
      excludeCredentials: input.excludeCredentialIds.map((id) => ({ id })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
    })
  }

  async verifyRegistrationResponse(input: {
    response: unknown
    expectedChallenge: string
  }): Promise<{ verified: boolean; passkey?: StoredPasskey }> {
    const verification = await verifyRegistrationResponse({
      response: input.response as RegistrationResponseJSON,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpID,
      requireUserVerification: true,
    })
    if (!verification.verified) return { verified: false }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo
    const passkey: StoredPasskey = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      webAuthnUserID: credential.id,
    }
    if (credential.transports !== undefined) passkey.transports = credential.transports
    return {
      verified: true,
      passkey,
    }
  }

  async generateAuthenticationOptions(input: {
    allowedCredentialIds: string[]
  }): Promise<PasskeyOptions> {
    return generateAuthenticationOptions({
      rpID: this.options.rpID,
      allowCredentials: input.allowedCredentialIds.map((id) => ({ id })),
      userVerification: 'required',
    })
  }

  async verifyAuthenticationResponse(input: {
    response: unknown
    expectedChallenge: string
    passkeys: StoredPasskey[]
  }): Promise<{ verified: boolean; credentialId?: string; newCounter?: number }> {
    const response = input.response as AuthenticationResponseJSON
    const passkey = input.passkeys.find((candidate) => candidate.id === response.id)
    if (!passkey) return { verified: false }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: input.expectedChallenge,
      expectedOrigin: this.options.origin,
      expectedRPID: this.options.rpID,
      credential: toWebAuthnCredential(passkey),
      requireUserVerification: true,
    })
    if (!verification.verified) return { verified: false }
    return {
      verified: true,
      credentialId: verification.authenticationInfo.credentialID,
      newCounter: verification.authenticationInfo.newCounter,
    }
  }
}

function toWebAuthnCredential(passkey: StoredPasskey): WebAuthnCredential {
  const credential: WebAuthnCredential = {
    id: passkey.id,
    publicKey: Buffer.from(passkey.publicKey, 'base64url'),
    counter: passkey.counter,
  }
  if (passkey.transports !== undefined) {
    credential.transports = passkey.transports as AuthenticatorTransportFuture[]
  }
  return credential
}
