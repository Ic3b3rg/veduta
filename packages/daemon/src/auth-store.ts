import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'

export type AuthMode = 'dev' | 'production'

export interface PasskeyOptions {
  challenge: string
}

export interface StoredPasskey {
  id: string
  publicKey: string
  counter: number
  transports?: string[]
  deviceType: string
  backedUp: boolean
  webAuthnUserID: string
}

export interface PasskeyRelyingParty {
  generateRegistrationOptions(input: {
    userId: string
    userName: string
    excludeCredentialIds: string[]
  }): Promise<PasskeyOptions>
  verifyRegistrationResponse(input: {
    response: unknown
    expectedChallenge: string
  }): Promise<{ verified: boolean; passkey?: StoredPasskey }>
  generateAuthenticationOptions(input: { allowedCredentialIds: string[] }): Promise<PasskeyOptions>
  verifyAuthenticationResponse(input: {
    response: unknown
    expectedChallenge: string
    passkeys: StoredPasskey[]
  }): Promise<{ verified: boolean; credentialId?: string; newCounter?: number }>
}

export interface AuthDevice {
  id: string
  name: string
  credentialId: string
  createdAt: string
  lastSeenAt?: string
  revokedAt?: string
}

export interface AuthSession {
  token: string
  device: AuthDevice
}

export interface PairingCode {
  code: string
  expiresAt: string
  pairingUri: string
}

export interface SessionRevokedEvent {
  tokenHash: string
  deviceId: string
}

export interface AuthState {
  bootstrapCodeHash?: string
  passkeys: PersistedPasskey[]
  devices: AuthDevice[]
  sessions: PersistedSession[]
}

export interface AuthStoreOptions {
  mode: AuthMode
  passkeys: PasskeyRelyingParty
  bootstrapCode?: string
  publicOrigin?: string
  now?: () => Date
  randomBytes?: (length: number) => Buffer
  state?: AuthState
  persist?: (state: AuthState) => void
}

export interface PersistedPasskey extends StoredPasskey {
  deviceId: string
  createdAt: string
  revokedAt?: string
}

export interface PersistedSession {
  id: string
  tokenHash: string
  deviceId: string
  scopes: ['gateway']
  createdAt: string
  expiresAt: string
  lastSeenAt?: string
  revokedAt?: string
}

interface RegistrationCeremony {
  id: string
  expectedChallenge: string
  deviceName: string
  codeHash: string
  expiresAt: string
  userId: string
}

interface AuthenticationCeremony {
  id: string
  expectedChallenge: string
  expiresAt: string
}

interface StoredPairingCode {
  codeHash: string
  createdByDeviceId: string
  expiresAt: string
  usedAt?: string
}

export class AuthStoreError extends Error {
  constructor(
    public readonly code:
      | 'invalid-code'
      | 'invalid-ceremony'
      | 'invalid-session'
      | 'invalid-passkey'
      | 'revoked-device',
    message: string,
  ) {
    super(message)
    this.name = 'AuthStoreError'
  }
}

export class AuthStore {
  private state: AuthState
  private registrationCeremonies = new Map<string, RegistrationCeremony>()
  private authenticationCeremonies = new Map<string, AuthenticationCeremony>()
  private pairingCodes = new Map<string, StoredPairingCode>()
  private revokedListeners = new Set<(event: SessionRevokedEvent) => void>()
  private sequence = 1
  private now: () => Date
  private randomBytes: (length: number) => Buffer
  private publicOrigin: string

  constructor(private readonly options: AuthStoreOptions) {
    this.now = options.now ?? (() => new Date())
    this.randomBytes = options.randomBytes ?? nodeRandomBytes
    this.publicOrigin = options.publicOrigin ?? 'https://veduta.local'
    this.state = options.state
      ? cloneState(options.state)
      : { passkeys: [], devices: [], sessions: [] }

    if (
      options.bootstrapCode &&
      !this.state.bootstrapCodeHash &&
      this.state.passkeys.every((passkey) => passkey.revokedAt)
    ) {
      this.state.bootstrapCodeHash = hashSecret(options.bootstrapCode)
    }
    this.sequence = nextSequence(this.state)
  }

  status(): { mode: AuthMode; passkeyRegistered: boolean; bootstrapRequired: boolean } {
    return {
      mode: this.options.mode,
      passkeyRegistered: this.activePasskeys().length > 0,
      bootstrapRequired: this.activePasskeys().length === 0,
    }
  }

  exportState(): AuthState {
    return cloneState(this.state)
  }

  async startPasskeyRegistration(input: {
    oneTimeCode: string
    deviceName: string
  }): Promise<{ ceremonyId: string; options: PasskeyOptions }> {
    const codeHash = hashSecret(input.oneTimeCode)
    this.assertValidOneTimeCode(codeHash)
    const userId = this.nextId('usr')
    const options = await this.options.passkeys.generateRegistrationOptions({
      userId,
      userName: 'veduta-owner',
      excludeCredentialIds: this.activePasskeys().map((passkey) => passkey.id),
    })
    const ceremonyId = this.nextId('reg')
    this.registrationCeremonies.set(ceremonyId, {
      id: ceremonyId,
      expectedChallenge: options.challenge,
      deviceName: input.deviceName,
      codeHash,
      expiresAt: minutesFrom(this.now(), 10),
      userId,
    })
    return { ceremonyId, options }
  }

  async finishPasskeyRegistration(input: {
    ceremonyId: string
    response: unknown
  }): Promise<AuthSession> {
    const ceremony = this.registrationCeremonies.get(input.ceremonyId)
    if (!ceremony || isPast(ceremony.expiresAt, this.now)) {
      throw new AuthStoreError(
        'invalid-ceremony',
        'registration ceremony expired or does not exist',
      )
    }

    const verification = await this.options.passkeys.verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: ceremony.expectedChallenge,
    })
    if (!verification.verified || !verification.passkey) {
      throw new AuthStoreError('invalid-passkey', 'passkey registration failed verification')
    }

    const existing = this.state.passkeys.find((passkey) => passkey.id === verification.passkey?.id)
    if (existing && !existing.revokedAt) {
      throw new AuthStoreError('invalid-passkey', 'passkey is already registered')
    }

    const deviceId = this.nextId('dev')
    const createdAt = this.now().toISOString()
    const passkey: PersistedPasskey = {
      ...verification.passkey,
      deviceId,
      createdAt,
    }
    const device: AuthDevice = {
      id: deviceId,
      name: inputName(ceremony.deviceName),
      credentialId: passkey.id,
      createdAt,
      lastSeenAt: createdAt,
    }

    this.state.passkeys.push(passkey)
    this.state.devices.push(device)
    this.consumeOneTimeCode(ceremony.codeHash)
    this.registrationCeremonies.delete(ceremony.id)
    return this.createSession(device)
  }

  async startPasskeyLogin(): Promise<{ ceremonyId: string; options: PasskeyOptions }> {
    const activePasskeys = this.activePasskeys()
    if (activePasskeys.length === 0) {
      throw new AuthStoreError('invalid-passkey', 'no passkeys are registered')
    }

    const options = await this.options.passkeys.generateAuthenticationOptions({
      allowedCredentialIds: activePasskeys.map((passkey) => passkey.id),
    })
    const ceremonyId = this.nextId('auth')
    this.authenticationCeremonies.set(ceremonyId, {
      id: ceremonyId,
      expectedChallenge: options.challenge,
      expiresAt: minutesFrom(this.now(), 5),
    })
    return { ceremonyId, options }
  }

  async finishPasskeyLogin(input: {
    ceremonyId: string
    response: unknown
    deviceName?: string
  }): Promise<AuthSession> {
    const ceremony = this.authenticationCeremonies.get(input.ceremonyId)
    if (!ceremony || isPast(ceremony.expiresAt, this.now)) {
      throw new AuthStoreError('invalid-ceremony', 'login ceremony expired or does not exist')
    }

    const activePasskeys = this.activePasskeys()
    const verification = await this.options.passkeys.verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: ceremony.expectedChallenge,
      passkeys: activePasskeys,
    })
    if (
      !verification.verified ||
      !verification.credentialId ||
      verification.newCounter === undefined
    ) {
      throw new AuthStoreError('invalid-passkey', 'passkey login failed verification')
    }

    const passkey = activePasskeys.find((candidate) => candidate.id === verification.credentialId)
    if (!passkey) throw new AuthStoreError('invalid-passkey', 'passkey is not registered')
    passkey.counter = verification.newCounter

    const device = this.activeDevice(passkey.deviceId)
    if (!device) throw new AuthStoreError('revoked-device', 'device has been revoked')
    device.lastSeenAt = this.now().toISOString()
    if (input.deviceName) device.name = inputName(input.deviceName)
    this.authenticationCeremonies.delete(ceremony.id)
    return this.createSession(device)
  }

  verifySession(token: string | undefined): AuthSession | undefined {
    if (!token) return undefined
    const tokenHash = hashSecret(token)
    const session = this.state.sessions.find(
      (candidate) =>
        safeEqual(candidate.tokenHash, tokenHash) &&
        !candidate.revokedAt &&
        !isPast(candidate.expiresAt, this.now),
    )
    if (!session) return undefined
    const device = this.activeDevice(session.deviceId)
    if (!device) return undefined
    session.lastSeenAt = this.now().toISOString()
    device.lastSeenAt = session.lastSeenAt
    return { token, device: { ...device } }
  }

  createPairingCode(token: string): PairingCode {
    const session = this.requireSession(token)
    const code = this.randomCode()
    const expiresAt = minutesFrom(this.now(), 10)
    this.pairingCodes.set(hashSecret(code), {
      codeHash: hashSecret(code),
      createdByDeviceId: session.device.id,
      expiresAt,
    })
    return {
      code,
      expiresAt,
      pairingUri: `${this.publicOrigin}/setup?code=${encodeURIComponent(code)}`,
    }
  }

  listDevices(token: string): AuthDevice[] {
    if (!this.verifySession(token)) return []
    return this.state.devices.filter((device) => !device.revokedAt).map((device) => ({ ...device }))
  }

  revokeDevice(token: string, deviceId: string): void {
    this.requireSession(token)
    const device = this.activeDevice(deviceId)
    if (!device) return
    const revokedAt = this.now().toISOString()
    device.revokedAt = revokedAt
    for (const passkey of this.state.passkeys) {
      if (passkey.deviceId === deviceId && !passkey.revokedAt) passkey.revokedAt = revokedAt
    }
    for (const session of this.state.sessions) {
      if (session.deviceId === deviceId && !session.revokedAt) {
        session.revokedAt = revokedAt
        this.emitRevoked({ tokenHash: session.tokenHash, deviceId })
      }
    }
    this.persist()
  }

  onSessionRevoked(listener: (event: SessionRevokedEvent) => void): () => void {
    this.revokedListeners.add(listener)
    return () => this.revokedListeners.delete(listener)
  }

  private requireSession(token: string): AuthSession {
    const session = this.verifySession(token)
    if (!session) throw new AuthStoreError('invalid-session', 'session is missing or revoked')
    return session
  }

  private activePasskeys(): PersistedPasskey[] {
    return this.state.passkeys.filter((passkey) => !passkey.revokedAt)
  }

  private activeDevice(deviceId: string): AuthDevice | undefined {
    return this.state.devices.find((device) => device.id === deviceId && !device.revokedAt)
  }

  private assertValidOneTimeCode(codeHash: string): void {
    if (this.activePasskeys().length === 0 && safeEqual(this.state.bootstrapCodeHash, codeHash))
      return
    const pairing = this.pairingCodes.get(codeHash)
    if (pairing && !pairing.usedAt && !isPast(pairing.expiresAt, this.now)) return
    throw new AuthStoreError('invalid-code', 'one-time code is invalid or expired')
  }

  private consumeOneTimeCode(codeHash: string): void {
    if (this.activePasskeys().length === 1 && safeEqual(this.state.bootstrapCodeHash, codeHash)) {
      delete this.state.bootstrapCodeHash
      return
    }
    const pairing = this.pairingCodes.get(codeHash)
    if (pairing) pairing.usedAt = this.now().toISOString()
  }

  private createSession(device: AuthDevice): AuthSession {
    const token = `vdt_${this.nextId('tok')}_${base64Url(this.randomBytes(32))}`
    const createdAt = this.now().toISOString()
    this.state.sessions.push({
      id: this.nextId('ses'),
      tokenHash: hashSecret(token),
      deviceId: device.id,
      scopes: ['gateway'],
      createdAt,
      expiresAt: daysFrom(this.now(), 30),
      lastSeenAt: createdAt,
    })
    device.lastSeenAt = createdAt
    this.persist()
    return { token, device: { ...device } }
  }

  private persist(): void {
    this.options.persist?.(this.exportState())
  }

  private randomCode(): string {
    const raw = base64Url(this.randomBytes(9)).replace(/[^a-zA-Z0-9]/g, '')
    return raw.slice(0, 12)
  }

  private nextId(prefix: string): string {
    const id = `${prefix}-${this.sequence}`
    this.sequence += 1
    return id
  }

  private emitRevoked(event: SessionRevokedEvent): void {
    for (const listener of this.revokedListeners) listener(event)
  }
}

function inputName(name: string): string {
  const trimmed = name.trim()
  return trimmed || 'Unnamed device'
}

function minutesFrom(date: Date, minutes: number): string {
  return new Date(date.getTime() + minutes * 60_000).toISOString()
}

function daysFrom(date: Date, days: number): string {
  return new Date(date.getTime() + days * 86_400_000).toISOString()
}

function isPast(iso: string, now: () => Date): boolean {
  return Date.parse(iso) <= now().getTime()
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url')
}

function safeEqual(left: string | undefined, right: string): boolean {
  if (!left) return false
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url')
}

function cloneState(state: AuthState): AuthState {
  const cloned: AuthState = {
    passkeys: state.passkeys.map((passkey) => ({ ...passkey })),
    devices: state.devices.map((device) => ({ ...device })),
    sessions: state.sessions.map((session) => ({ ...session })),
  }
  if (state.bootstrapCodeHash !== undefined) cloned.bootstrapCodeHash = state.bootstrapCodeHash
  return cloned
}

function nextSequence(state: AuthState): number {
  const ids = [
    ...state.devices.map((device) => device.id),
    ...state.sessions.map((session) => session.id),
    ...state.passkeys.map((passkey) => passkey.deviceId),
  ]
  const max = ids.reduce((current, id) => {
    const value = Number(id.split('-').at(-1))
    return Number.isInteger(value) ? Math.max(current, value) : current
  }, 0)
  return max + 1
}
