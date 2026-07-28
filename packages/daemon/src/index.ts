import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { AuthStore } from './auth-store.ts'
import { loadAuthState, saveAuthState } from './auth-state-file.ts'
import { installConsoleRedaction } from './redaction.ts'
import { buildServer } from './server.ts'
import { AcmeCertificateManager, AcmeChallengeStore, createHttp01RequestHandler } from './tls.ts'
import { SimpleWebAuthnRelyingParty } from './webauthn.ts'

start().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function start(): Promise<void> {
  // Every current and future console sink is covered from the very first
  // line (issue #15): nothing logs before secrets can be redacted.
  installConsoleRedaction()
  const dataDirOption = process.env.VEDUTA_DATA_DIR ? { dataDir: process.env.VEDUTA_DATA_DIR } : {}
  const domain = process.env.VEDUTA_PUBLIC_DOMAIN
  if (!domain) {
    const port = Number(process.env.PORT ?? 8787)
    const { app } = buildServer({ ...dataDirOption })
    await app.listen({ port, host: '127.0.0.1' })
    console.log(`veduta daemon (dev profile) -> http://127.0.0.1:${port}`)
    return
  }

  const email = requireEnv('VEDUTA_ACME_EMAIL')
  const origin = `https://${domain}`
  const authStatePath = process.env.VEDUTA_AUTH_STATE ?? join(process.cwd(), '.veduta/auth.json')
  const authState = loadAuthState(authStatePath)
  const bootstrapCode =
    process.env.VEDUTA_BOOTSTRAP_CODE ?? randomBytes(9).toString('base64url').slice(0, 12)
  const authOptions = {
    mode: 'production',
    bootstrapCode,
    publicOrigin: origin,
    persist: (state) => saveAuthState(authStatePath, state),
    passkeys: new SimpleWebAuthnRelyingParty({
      rpName: 'Veduta',
      rpID: domain,
      origin,
    }),
  } satisfies ConstructorParameters<typeof AuthStore>[0]
  const auth = new AuthStore(authState ? { ...authOptions, state: authState } : authOptions)

  if (auth.status().bootstrapRequired) {
    // `auth.bootstrapCode()` (not the local `bootstrapCode` this process
    // generated/read from the env) is the effective code: a restart after a
    // code expired unconsumed mints and persists a
    // fresh one internally, and this accessor is the seam that surfaces it —
    // printing the stale local value here would print a code that no longer
    // works.
    const effectiveCode = auth.bootstrapCode()
    if (effectiveCode) {
      console.log(`veduta first-boot code: ${effectiveCode}`)
      console.log(`veduta first-boot setup URL: ${origin}/setup?code=${effectiveCode}`)
    }
  }

  const challenges = new AcmeChallengeStore()
  const httpPort = Number(process.env.HTTP_PORT ?? 80)
  const httpsPort = Number(process.env.HTTPS_PORT ?? 443)
  const http01Handler = createHttp01RequestHandler({ domain, challenges })
  const redirectServer = createServer((request, response) => http01Handler(request, response))
  await listenHttp(redirectServer, httpPort)

  const certificateOptions = {
    domain,
    email,
    challenges,
    certDir: process.env.VEDUTA_ACME_DIR ?? join(process.cwd(), '.veduta/acme'),
  }
  const certManager = new AcmeCertificateManager(
    process.env.VEDUTA_ACME_DIRECTORY_URL
      ? { ...certificateOptions, directoryUrl: process.env.VEDUTA_ACME_DIRECTORY_URL }
      : certificateOptions,
  )
  const certificate = await certManager.loadOrIssue()
  const { app } = buildServer({
    ...dataDirOption,
    https: certificate,
    auth: { mode: 'production', store: auth, allowedOrigins: [origin] },
    // Global egress enforcement (issue #15): only the production/VPS
    // profile installs the process-wide denying dispatcher.
    egress: { enforce: true },
    // Onboarding wizard wiring (issue #19): the VPS profile's real
    // domain/TLS state, so the wizard's `domain` step reflects what this
    // daemon actually detected rather than the loopback defaults.
    onboarding: { domain, tlsActive: true, env: process.env },
  })
  await app.listen({ port: httpsPort, host: '0.0.0.0' })
  console.log(`veduta daemon (production profile) -> ${origin}`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for the production profile`)
  return value
}

function listenHttp(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
}
