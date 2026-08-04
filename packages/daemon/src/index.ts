import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { AuthStore } from './auth-store.ts'
import { loadAuthState, saveAuthState } from './auth-state-file.ts'
import { resolveProfile, type ResolvedProfile } from './profile.ts'
import { installConsoleRedaction } from './redaction.ts'
import { buildServer } from './server.ts'
import { AcmeCertificateManager, AcmeChallengeStore, createHttp01RequestHandler } from './tls.ts'
import { runSelfCheck } from './update/self-check.ts'
import { SimpleWebAuthnRelyingParty } from './webauthn.ts'

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

async function main(): Promise<void> {
  // Every current and future console sink is covered from the very first
  // line (issue #15): nothing logs before secrets can be redacted, in
  // either mode this process can run in.
  installConsoleRedaction()

  if (process.argv.includes('--self-check') || process.env['VEDUTA_SELF_CHECK'] === '1') {
    await runSelfCheckMode()
    return
  }

  await start()
}

/**
 * Stage 1 of the update wrapper's health check (`docs/adr/0013-signed-self-update.md`'s
 * self-update amendments, `issues/043-self-update.md` AC3): a hermetic,
 * read-only inspection of an already-migrated data root, run as its own
 * process invocation rather than as a flag `start()` interprets — the
 * wrapper needs an exit code from a process that never calls `buildServer`
 * at all, not a daemon that happens to also validate itself before serving.
 */
async function runSelfCheckMode(): Promise<void> {
  const rootDir = process.env['VEDUTA_DATA_DIR']
  if (!rootDir) {
    console.error('--self-check requires VEDUTA_DATA_DIR to be set')
    process.exit(2)
    return
  }

  const report = await runSelfCheck({ rootDir })
  for (const check of report.checks) {
    console.error(`self-check ${check.name}: ${check.ok ? 'ok' : 'FAIL'} ${check.detail}`)
  }
  console.error(`self-check: ${report.ok ? 'ok' : 'failed'}`)
  process.exit(report.ok ? 0 : 1)
}

async function start(): Promise<void> {
  const dataDirOption = process.env.VEDUTA_DATA_DIR ? { dataDir: process.env.VEDUTA_DATA_DIR } : {}
  const resolved = resolveProfile(process.env)

  if (resolved.profile === 'loopback') {
    const port = Number(process.env.PORT ?? 8787)
    const { app } = buildServer({ ...dataDirOption })
    await app.listen({ port, host: '127.0.0.1' })
    console.log(`veduta daemon (dev profile) -> http://127.0.0.1:${port}`)
    return
  }

  if (resolved.profile === 'local-vps') {
    await startLocalVps(resolved)
    return
  }

  await startVps()
}

/**
 * The Local VPS profile (issue 023, `docs/adr/0009-local-vps-profile.md`):
 * real passkey auth over plain `http://localhost` in place of the `vps`
 * profile's public domain + ACME/TLS, and this process itself (restarted by
 * a runner loop) in place of systemd's `Restart=always`. Everything else —
 * production `AuthStore`, egress enforcement, the onboarding wizard — is the
 * same production wiring the `vps` profile uses. Browsers treat `localhost`
 * as a secure context without TLS, so WebAuthn works here, but only when the
 * user opens `http://localhost:<port>` in the browser — `127.0.0.1` is a
 * different WebAuthn origin and will not match the registered passkey's
 * `rpID`.
 */
async function startLocalVps(
  resolved: Extract<ResolvedProfile, { profile: 'local-vps' }>,
): Promise<void> {
  const { port, origin, dataDir, vaultKeyfile } = resolved
  const authStatePath = process.env.VEDUTA_AUTH_STATE ?? join(dataDir, 'auth.json')
  const bootstrapCode =
    process.env.VEDUTA_BOOTSTRAP_CODE ?? randomBytes(9).toString('base64url').slice(0, 12)
  const auth = buildProductionAuth({ rpID: 'localhost', origin, authStatePath, bootstrapCode })

  if (vaultKeyfile) {
    // `resolveVaultKeyMaterial` (secrets-vault.ts) reads this env var
    // directly; this is the profile's only way to hand it a keyfile path
    // without requiring the caller to set it themselves.
    process.env.VEDUTA_VAULT_KEYFILE = vaultKeyfile
  }

  const { app } = buildServer({
    dataDir,
    auth: { mode: 'production', store: auth, allowedOrigins: [origin] },
    // Global egress enforcement (issue #15): the Local VPS profile is
    // production-like auth, so it gets the same denying dispatcher the vps
    // profile does.
    egress: { enforce: true },
    profile: 'local-vps',
    onboarding: { domain: 'localhost', tlsActive: false, env: process.env },
  })
  await app.listen({ port, host: '127.0.0.1' })
  // The runner loop and e2e coverage wait on this exact line, so it must
  // print on every boot of this profile, not just the first.
  console.log(`veduta daemon (local vps profile) -> http://localhost:${port}`)
}

async function startVps(): Promise<void> {
  const domain = requireEnv('VEDUTA_PUBLIC_DOMAIN')
  const email = requireEnv('VEDUTA_ACME_EMAIL')
  const origin = `https://${domain}`
  const authStatePath = process.env.VEDUTA_AUTH_STATE ?? join(process.cwd(), '.veduta/auth.json')
  const bootstrapCode =
    process.env.VEDUTA_BOOTSTRAP_CODE ?? randomBytes(9).toString('base64url').slice(0, 12)
  const auth = buildProductionAuth({ rpID: domain, origin, authStatePath, bootstrapCode })

  const dataDirOption = process.env.VEDUTA_DATA_DIR ? { dataDir: process.env.VEDUTA_DATA_DIR } : {}
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

/**
 * Builds the production `AuthStore` shared by the `vps` and `local-vps`
 * profiles (issue 023, `docs/adr/0009-local-vps-profile.md`): loading any
 * persisted auth state, wiring the `SimpleWebAuthnRelyingParty`, and
 * printing the first-boot code, all in one place so the two profiles'
 * passkey setup cannot drift apart. The only differences between the
 * profiles — `rpID` (the real domain vs `localhost`) and where
 * `VEDUTA_AUTH_STATE` defaults to (`<cwd>/.veduta/auth.json` for `vps`,
 * `<dataDir>/auth.json` for `local-vps`) — are resolved by each caller
 * before this runs, since only the caller knows which profile it is.
 */
function buildProductionAuth(options: {
  rpID: string
  origin: string
  authStatePath: string
  bootstrapCode: string
}): AuthStore {
  const { rpID, origin, authStatePath, bootstrapCode } = options
  const authState = loadAuthState(authStatePath)
  const authOptions = {
    mode: 'production',
    bootstrapCode,
    publicOrigin: origin,
    persist: (state) => saveAuthState(authStatePath, state),
    passkeys: new SimpleWebAuthnRelyingParty({
      rpName: 'Veduta',
      rpID,
      origin,
    }),
  } satisfies ConstructorParameters<typeof AuthStore>[0]
  const auth = new AuthStore(authState ? { ...authOptions, state: authState } : authOptions)
  printFirstBootCode(auth, origin)
  return auth
}

/**
 * Prints the first-boot bootstrap code and setup URL, shared by the `vps`
 * and `local-vps` profiles (issue 023, `docs/adr/0009-local-vps-profile.md`).
 * Reads `auth.bootstrapCode()` — not the caller's local `bootstrapCode`
 * value this process generated/read from the env — because a restart after
 * a code expired unconsumed mints and persists a fresh one internally, and
 * this accessor is the seam that surfaces it; printing the stale local value
 * here would print a code that no longer works.
 */
function printFirstBootCode(auth: AuthStore, origin: string): void {
  if (!auth.status().bootstrapRequired) return
  const effectiveCode = auth.bootstrapCode()
  if (effectiveCode) {
    console.log(`veduta first-boot code: ${effectiveCode}`)
    console.log(`veduta first-boot setup URL: ${origin}/setup?code=${effectiveCode}`)
  }
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
