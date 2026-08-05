import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { UpdateMarkerSchema, type UpdateMarker } from '../../protocol/src/update.ts'
import {
  buildManifest,
  buildReleaseArtifact,
  buildReleaseMetadata,
  flipByte,
  generateFixtureKeys,
  preCreateRuntimeDir,
  signReleaseMetadata,
  signSigningKeyCert,
  startFeedServer,
  writePinningFile,
  type BuiltArtifact,
  type FixtureKeys,
} from './update-fixture.ts'
import { cleanupStackDirs, findFreePort, startLocalVpsStack, type LocalVpsStack } from './stack.ts'

/**
 * Real-browser e2e for signed self-update (issue #43,
 * `docs/adr/0013-signed-self-update.md`; `issues/043-self-update.md`
 * AC1-AC4). Every scenario below builds its own fresh Local VPS stack (a
 * fresh temp base dir, a fresh local feed server standing in for the real
 * gated `stable.json`) so scenarios never share update-transaction state --
 * only the release artifact + minisign trust chain (expensive to build, but
 * read-only once built) come from a single `beforeAll`.
 *
 * AC1/AC2/AC3 drive the Update Surface (`update-surface.ts`) through a real
 * Chromium instance, the same WebAuthn-virtual-authenticator +
 * onboarding-wizard journey `local-vps.spec.ts` already established. AC4 is
 * deliberately wrapper-level only (no browser, per issues/043-self-update.md's
 * own framing of the interrupted-transaction criterion): it arms a marker
 * directly and drives `deploy/veduta-run` as a raw child process so it can
 * hard-kill the whole process group mid-transaction, something the shared
 * `LocalVpsStack` helper (`stack.ts`) deliberately does not expose (it only
 * ever does a graceful `SIGTERM` stop, which `local-vps.spec.ts` relies on
 * staying that way).
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const VEDUTA_RUN_SCRIPT = join(REPO_ROOT, 'deploy', 'veduta-run')

const RELEASE_VERSION = '9.9.9'
const RELEASE_VERSION_2 = '9.9.10'
/**
 * Parseable stand-in for `VEDUTA_VERSION` (`server.ts`/`update-cli.ts` read
 * `VEDUTA_INSTALLED_VERSION` when set) -- this checkout's own `version.ts`
 * stays the literal dev placeholder `'0.0.0-dev'`, which `compareVersions`/
 * `checkMonotonic` cannot parse (by design: only a release build's artifact
 * copy ever carries a real `x.y.z`).
 */
const INSTALLED_VERSION = '0.0.1'
const NOTES_MARKER = 'e2e-update-notes-043'

test.describe.configure({ mode: 'serial' })

test.describe('signed self-update (issue #43, docs/adr/0013-signed-self-update.md)', () => {
  let artifactWorkDir: string
  let artifact: BuiltArtifact
  let artifact2: BuiltArtifact
  let artifactBytes: Buffer
  let keys: FixtureKeys
  let attackerKeys: FixtureKeys
  let signingCert: ReturnType<typeof signSigningKeyCert>
  let badSigningCert: ReturnType<typeof signSigningKeyCert>
  let goodReleaseBytes: Buffer
  let goodReleaseSig: string
  let good2ReleaseBytes: Buffer
  let good2ReleaseSig: string

  // Playwright requires the first parameter of a hook to be a destructuring
  // pattern even when no fixture is used, so one fixture is destructured and
  // deliberately ignored rather than writing an empty pattern.
  test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
    testInfo.setTimeout(5 * 60_000)
    artifactWorkDir = await mkdtemp(join(tmpdir(), 'veduta-e2e-selfupdate-artifact-'))

    artifact = await buildReleaseArtifact({ workDir: artifactWorkDir, version: RELEASE_VERSION })
    artifactBytes = await readFile(artifact.artifactPath)
    // A second release sharing the same trust chain -- used only by AC3's
    // second (rollback) round, so it needs a genuinely different `version`
    // (monotonicity) but not a functionally different artifact.
    artifact2 = await buildReleaseArtifact({ workDir: artifactWorkDir, version: RELEASE_VERSION_2 })

    keys = generateFixtureKeys()
    attackerKeys = generateFixtureKeys()
    signingCert = signSigningKeyCert(keys)
    // AC2's "un-rooted key" case: the same signing key, but its certificate
    // is rooted by a DIFFERENT root than the one written into the pinning
    // file below -- `verifyReleaseChain` must refuse this before ever
    // recording an offer.
    badSigningCert = signSigningKeyCert(keys, attackerKeys)

    const release = buildReleaseMetadata(artifact, { dataVersion: 1, notesMarker: NOTES_MARKER })
    const signed = signReleaseMetadata(release, keys.signing)
    goodReleaseBytes = signed.releaseBytes
    goodReleaseSig = signed.releaseSig

    const release2 = buildReleaseMetadata(artifact2, { dataVersion: 1, notesMarker: NOTES_MARKER })
    const signed2 = signReleaseMetadata(release2, keys.signing)
    good2ReleaseBytes = signed2.releaseBytes
    good2ReleaseSig = signed2.releaseSig
  })

  test.afterAll(async () => {
    if (artifactWorkDir) await rm(artifactWorkDir, { recursive: true, force: true })
  })

  test('AC1 happy path: check, apply, new version serves with data intact', async ({ browser }) => {
    test.setTimeout(20 * 60_000)
    const baseDir = await mkdtemp(join(tmpdir(), 'veduta-e2e-selfupdate-ac1-'))
    const feed = await startFeedServer()
    const context = await browser.newContext()
    let stack: LocalVpsStack | undefined
    try {
      const artifactUrl = `${feed.origin}/${artifact.artifactName}`
      feed.setArtifact(artifact.artifactName, artifactBytes)
      feed.setManifest(
        manifestBytes({
          releaseBytes: goodReleaseBytes,
          releaseSig: goodReleaseSig,
          signingKeyCert: signingCert,
          artifactUrl,
        }),
      )
      writePinningFile(join(baseDir, 'update.json'), {
        feedUrl: feed.feedUrl,
        rootPublicKey: keys.root.publicKeyText,
      })
      preCreateRuntimeDir(join(baseDir, 'updates'), artifact.nodeVersion)

      const page = await context.newPage()
      await addVirtualAuthenticator(context, page)

      stack = await startLocalVpsStack({
        baseDir,
        extraEnv: { VEDUTA_INSTALLED_VERSION: INSTALLED_VERSION },
      })
      await onboardMinimal(page, stack)

      const preEvents = await fetchSpaceEvents(page, stack.origin, 'spc-health')
      expect(preEvents.length).toBeGreaterThan(0)

      await focusSystemSpace(page)
      const updates = surfaceCard(page, 'Updates')
      await expect(updates.getByRole('button', { name: 'Check now' })).toBeVisible()
      await updates.getByRole('button', { name: 'Check now' }).click()
      await expect(updates.getByText(RELEASE_VERSION)).toBeVisible({ timeout: 30_000 })
      await expect(updates.getByText(`Test release notes: ${NOTES_MARKER}`)).toBeVisible()

      await updates.getByRole('button', { name: 'Apply update' }).click()

      // The wrapper restarts the daemon at least once through the whole
      // transaction (the flipped-to release's own boot) -- the ready line
      // regex matches every boot, per `stack.ts`'s own contract.
      await stack.waitForReadyLine(5 * 60_000)

      await expect
        .poll(async () => (await fetchHealth(page, stack!.origin))?.version, {
          timeout: 5 * 60_000,
          intervals: [2_000],
        })
        .toBe(RELEASE_VERSION)

      const health = await fetchHealth(page, stack.origin)
      expect(health).toMatchObject({ version: RELEASE_VERSION, dataVersion: 1 })

      await page.reload()
      await expect(page.getByRole('heading', { name: 'Health' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Focus Groceries' })).toBeVisible()

      const postEvents = await fetchSpaceEvents(page, stack.origin, 'spc-health')
      expect(postEvents.length).toBeGreaterThanOrEqual(preEvents.length)

      const backups = await readdir(join(baseDir, 'updates', 'backups'))
      expect(backups.length).toBeGreaterThan(0)

      await expect
        .poll(
          async () => {
            const events = await fetchSpaceEvents(page, stack!.origin, 'spc-system')
            return events.some(
              (event) => event.type === 'update.outcome' && event.payload?.outcome === 'success',
            )
          },
          { timeout: 60_000 },
        )
        .toBe(true)

      await focusSystemSpace(page)
      await expect(surfaceCard(page, 'Updates').getByText(RELEASE_VERSION)).toBeVisible()

      const currentTarget = await readlink(join(baseDir, 'updates', 'releases', 'current'))
      expect(currentTarget).toContain(`v${RELEASE_VERSION}`)

      await expect(page.getByRole('alert')).toHaveCount(0)
    } finally {
      await stack?.stop()
      if (stack) await cleanupStackDirs(stack)
      await feed.close()
      await context.close()
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('AC2 bad signature: check fails honestly, tampered artifact refused with zero mutation', async ({
    browser,
  }) => {
    test.setTimeout(20 * 60_000)
    const baseDir = await mkdtemp(join(tmpdir(), 'veduta-e2e-selfupdate-ac2-'))
    const feed = await startFeedServer()
    const context = await browser.newContext()
    let stack: LocalVpsStack | undefined
    try {
      writePinningFile(join(baseDir, 'update.json'), {
        feedUrl: feed.feedUrl,
        rootPublicKey: keys.root.publicKeyText,
      })
      preCreateRuntimeDir(join(baseDir, 'updates'), artifact.nodeVersion)

      const artifactUrl = `${feed.origin}/${artifact.artifactName}`
      feed.setArtifact(artifact.artifactName, artifactBytes)

      // Step A: a certificate signed by an UN-ROOTED key -- `verifyReleaseChain`
      // must refuse before ever recording an offer.
      feed.setManifest(
        manifestBytes({
          releaseBytes: goodReleaseBytes,
          releaseSig: goodReleaseSig,
          signingKeyCert: badSigningCert,
          artifactUrl,
        }),
      )

      const page = await context.newPage()
      await addVirtualAuthenticator(context, page)

      stack = await startLocalVpsStack({
        baseDir,
        extraEnv: { VEDUTA_INSTALLED_VERSION: INSTALLED_VERSION },
      })
      await onboardMinimal(page, stack)

      const preHealthEvents = await fetchSpaceEvents(page, stack.origin, 'spc-health')

      await focusSystemSpace(page)
      const updates = surfaceCard(page, 'Updates')
      await updates.getByRole('button', { name: 'Check now' }).click()

      await expect
        .poll(
          async () => {
            const events = await fetchSpaceEvents(page, stack!.origin, 'spc-system')
            return events.some(
              (event) => event.type === 'update.check' && event.text.includes('check failed'),
            )
          },
          { timeout: 30_000 },
        )
        .toBe(true)
      await expect(updates.getByRole('button', { name: 'Apply update' })).toHaveCount(0)

      // Step B: a properly rooted chain (the check passes, an offer is
      // recorded) but the SERVED artifact bytes are tampered while the
      // signed metadata still names the original bytes' sha256 -- the
      // transaction's own hash check must refuse this, not the chain
      // verification.
      feed.setManifest(
        manifestBytes({
          releaseBytes: goodReleaseBytes,
          releaseSig: goodReleaseSig,
          signingKeyCert: signingCert,
          artifactUrl,
        }),
      )
      feed.setArtifact(artifact.artifactName, flipByte(artifactBytes, 1000))

      await updates.getByRole('button', { name: 'Check now' }).click()
      await expect(updates.getByRole('button', { name: 'Apply update' })).toBeVisible({
        timeout: 30_000,
      })
      await updates.getByRole('button', { name: 'Apply update' }).click()

      // The daemon exits 75, the wrapper's transaction refuses before ever
      // reaching `backup-done`, and the OLD release restarts.
      await stack.waitForReadyLine(5 * 60_000)

      await expect
        .poll(async () => (await fetchHealth(page, stack!.origin))?.version, {
          timeout: 60_000,
          intervals: [2_000],
        })
        .toBe(INSTALLED_VERSION)

      await page.reload()

      const backupsDir = join(baseDir, 'updates', 'backups')
      const backups = existsSync(backupsDir) ? await readdir(backupsDir) : []
      expect(backups).toHaveLength(0)
      expect(existsSync(join(baseDir, 'updates', 'releases', 'current'))).toBe(false)

      const postHealthEvents = await fetchSpaceEvents(page, stack.origin, 'spc-health')
      expect(postHealthEvents.length).toBe(preHealthEvents.length)

      await expect
        .poll(
          async () => {
            const events = await fetchSpaceEvents(page, stack!.origin, 'spc-system')
            return events.some(
              (event) => event.type === 'update.outcome' && event.payload?.outcome === 'refused',
            )
          },
          { timeout: 30_000 },
        )
        .toBe(true)

      await focusSystemSpace(page)
      await expect(surfaceCard(page, 'Updates').getByText(/sha256 mismatch/i)).toBeVisible({
        timeout: 10_000,
      })
    } finally {
      await stack?.stop()
      if (stack) await cleanupStackDirs(stack)
      await feed.close()
      await context.close()
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('AC3 failed health check rolls back automatically', async ({ browser }) => {
    test.setTimeout(20 * 60_000)
    const baseDir = await mkdtemp(join(tmpdir(), 'veduta-e2e-selfupdate-ac3-'))
    const feed = await startFeedServer()
    const context = await browser.newContext()
    let stack: LocalVpsStack | undefined
    try {
      writePinningFile(join(baseDir, 'update.json'), {
        feedUrl: feed.feedUrl,
        rootPublicKey: keys.root.publicKeyText,
      })
      preCreateRuntimeDir(join(baseDir, 'updates'), artifact.nodeVersion)

      const artifactUrl = `${feed.origin}/${artifact.artifactName}`
      feed.setArtifact(artifact.artifactName, artifactBytes)
      feed.setManifest(
        manifestBytes({
          releaseBytes: goodReleaseBytes,
          releaseSig: goodReleaseSig,
          signingKeyCert: signingCert,
          artifactUrl,
        }),
      )

      const page = await context.newPage()
      await addVirtualAuthenticator(context, page)

      stack = await startLocalVpsStack({
        baseDir,
        extraEnv: { VEDUTA_INSTALLED_VERSION: INSTALLED_VERSION },
      })
      await onboardMinimal(page, stack)

      // Round 1 (test knobs off): a normal happy update to v9.9.9,
      // establishing `releases/current` -- so round 2's rollback (below) has
      // a real previous release to flip back to. `update-transaction.ts`'s
      // `performRollback` only flips `current` back when the journal's
      // `executorRelease` is non-empty (there WAS a previously-serving
      // release); a genuinely first-ever-update rollback after the symlink
      // flip has nothing to revert to, which round 1 here sidesteps by
      // making this round 2's "first-ever update" instead.
      await focusSystemSpace(page)
      let updates = surfaceCard(page, 'Updates')
      await updates.getByRole('button', { name: 'Check now' }).click()
      await expect(updates.getByRole('button', { name: 'Apply update' })).toBeVisible({
        timeout: 30_000,
      })
      await updates.getByRole('button', { name: 'Apply update' }).click()
      await stack.waitForReadyLine(5 * 60_000)
      await expect
        .poll(async () => (await fetchHealth(page, stack!.origin))?.version, {
          timeout: 5 * 60_000,
          intervals: [2_000],
        })
        .toBe(RELEASE_VERSION)
      await page.reload()
      await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible({
        timeout: 30_000,
      })

      const preRollbackEvents = await fetchSpaceEvents(page, stack.origin, 'spc-health')

      // Round 2 (test knobs on): restart the same runner with the
      // self-check-fail knob armed, then offer v9.9.10 -- its own staged
      // self-check is forced to fail (`self-check.ts`'s
      // `VEDUTA_TEST_FAIL_SELF_CHECK`), so the transaction rolls back
      // automatically, with no operator input.
      await stack.stop()
      stack = await startLocalVpsStack({
        port: stack.port,
        baseDir: stack.baseDir,
        legacyHome: stack.legacyHome,
        extraEnv: {
          VEDUTA_INSTALLED_VERSION: INSTALLED_VERSION,
          VEDUTA_UPDATE_TEST_KNOBS: '1',
          VEDUTA_TEST_FAIL_SELF_CHECK: '1',
        },
      })
      await stack.waitForReadyLine()
      await page.reload()
      await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible({
        timeout: 30_000,
      })

      const artifact2Bytes = await readFile(artifact2.artifactPath)
      const artifactUrl2 = `${feed.origin}/${artifact2.artifactName}`
      feed.setArtifact(artifact2.artifactName, artifact2Bytes)
      feed.setManifest(
        manifestBytes({
          releaseBytes: good2ReleaseBytes,
          releaseSig: good2ReleaseSig,
          signingKeyCert: signingCert,
          artifactUrl: artifactUrl2,
        }),
      )

      await focusSystemSpace(page)
      updates = surfaceCard(page, 'Updates')
      await updates.getByRole('button', { name: 'Check now' }).click()
      await expect(updates.getByRole('button', { name: 'Apply update' })).toBeVisible({
        timeout: 30_000,
      })
      await updates.getByRole('button', { name: 'Apply update' }).click()

      await stack.waitForReadyLine(5 * 60_000)
      await expect
        .poll(async () => (await fetchHealth(page, stack!.origin))?.version, {
          timeout: 5 * 60_000,
          intervals: [2_000],
        })
        .toBe(RELEASE_VERSION)

      await page.reload()
      const postRollbackEvents = await fetchSpaceEvents(page, stack.origin, 'spc-health')
      expect(postRollbackEvents.length).toBe(preRollbackEvents.length)

      const logPath = join(baseDir, 'updates', 'state', 'logs', `${RELEASE_VERSION_2}.log`)
      expect(existsSync(logPath)).toBe(true)
      const logContent = readFileSync(logPath, 'utf8')
      expect(logContent.length).toBeGreaterThan(0)
      expect(logContent).toContain('VEDUTA_TEST_FAIL_SELF_CHECK')

      await expect
        .poll(
          async () => {
            const events = await fetchSpaceEvents(page, stack!.origin, 'spc-system')
            return events.some(
              (event) =>
                event.type === 'update.outcome' && event.payload?.outcome === 'rolled-back',
            )
          },
          { timeout: 30_000 },
        )
        .toBe(true)

      await focusSystemSpace(page)
      await expect(surfaceCard(page, 'Updates').getByText(/self-check failed/i)).toBeVisible({
        timeout: 10_000,
      })
    } finally {
      await stack?.stop()
      if (stack) await cleanupStackDirs(stack)
      await feed.close()
      await context.close()
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  test('AC4 hard-kill mid-transaction recovers on restart (wrapper-level, no browser)', async () => {
    test.setTimeout(10 * 60_000)
    const baseDir = await mkdtemp(join(tmpdir(), 'veduta-e2e-selfupdate-ac4-'))
    const feed = await startFeedServer()
    let run: DirectRun | undefined
    try {
      const dataDir = join(baseDir, 'data')
      const updateHome = join(baseDir, 'updates')
      const pinningPath = join(baseDir, 'update.json')
      const vaultKeyfile = join(baseDir, 'vault.key')
      await mkdir(dataDir, { recursive: true })
      writeFileSync(vaultKeyfile, `${randomBytes(48).toString('base64')}\n`, { mode: 0o400 })

      writePinningFile(pinningPath, {
        feedUrl: feed.feedUrl,
        rootPublicKey: keys.root.publicKeyText,
      })
      preCreateRuntimeDir(updateHome, artifact.nodeVersion)

      const port = await findFreePort()

      // Establish the data root (`data-version.json`, the seeded Health
      // Space) with one clean boot -- `veduta-run` with no marker/journal
      // present behaves exactly like the plain daemon it wraps.
      run = spawnVedutaRunDirect({
        port,
        dataDir,
        vaultKeyfile,
        updateHome,
        updatePinning: pinningPath,
      })
      await run.waitForReadyLine(60_000)
      run.kill('SIGTERM')
      await run.exited

      // Arm a transaction directly, bypassing the Update Surface entirely --
      // AC4 is about wrapper-level recovery from an arbitrary hard-kill, not
      // about how the marker got there.
      const artifactUrl = `${feed.origin}/${artifact.artifactName}`
      feed.setArtifact(artifact.artifactName, artifactBytes)
      const marker: UpdateMarker = UpdateMarkerSchema.parse({
        requestedAt: new Date().toISOString(),
        release: goodReleaseBytes.toString('base64'),
        releaseSig: goodReleaseSig,
        signingKey: signingCert,
        artifactUrl,
      })
      const stateDir = join(updateHome, 'state')
      await mkdir(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'marker.json'), `${JSON.stringify(marker, null, 2)}\n`)

      run = spawnVedutaRunDirect({
        port,
        dataDir,
        vaultKeyfile,
        updateHome,
        updatePinning: pinningPath,
      })

      const journalPath = join(stateDir, 'update-state.json')
      const migratedDeadline = Date.now() + 60_000
      let sawMigrated = false
      while (Date.now() < migratedDeadline) {
        if (existsSync(journalPath)) {
          try {
            const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { phase?: string }
            if (journal.phase === 'migrated') {
              sawMigrated = true
              break
            }
          } catch {
            // A tmp+rename write in flight -- retry on the next tick.
          }
        }
        await sleep(100)
      }
      expect(sawMigrated).toBe(true)

      // The hard kill: the whole process group, mid-transaction -- before
      // any daemon has been backgrounded for this loop iteration (the
      // migrate/flip/self-check sequence all runs synchronously inside the
      // single `update-cli.ts run` invocation, so there is nothing else in
      // this group to escape the signal at this exact point).
      run.kill('SIGKILL')
      await run.exited

      // Restart on the same base dir -- the next run must resume forward or
      // revert, never leave the journal (or the data root) in a half-done
      // state.
      run = spawnVedutaRunDirect({
        port,
        dataDir,
        vaultKeyfile,
        updateHome,
        updatePinning: pinningPath,
      })
      await run.waitForReadyLine(3 * 60_000)

      const archivedDeadline = Date.now() + 30_000
      while (Date.now() < archivedDeadline && existsSync(journalPath)) {
        await sleep(250)
      }

      run.kill('SIGTERM')
      await run.exited

      const currentPath = join(updateHome, 'releases', 'current')
      const currentResolved = existsSync(currentPath) ? await readlink(currentPath) : undefined
      const historyDir = join(updateHome, 'state', 'history')
      const historyEntries = existsSync(historyDir) ? await readdir(historyDir) : []
      const rolledBackResult = historyEntries.some((name) => {
        if (!name.endsWith('-result.json')) return false
        const parsed = JSON.parse(readFileSync(join(historyDir, name), 'utf8')) as {
          outcome?: string
        }
        return parsed.outcome === 'rolled-back'
      })

      // The invariant AC4 actually protects: never old code serving
      // migrated data. This scenario never forces a self-check failure, so
      // the expected recovery is a forward resume to v9.9.9 -- a
      // rollback-only history entry is still accepted here as a safe (if
      // more conservative) outcome of resuming from an arbitrary hard-kill
      // point; the fine-grained per-phase window assertions already live in
      // `update-transaction.test.ts`.
      expect(currentResolved?.includes(`v${RELEASE_VERSION}`) === true || rolledBackResult).toBe(
        true,
      )
      expect(existsSync(journalPath)).toBe(false)
    } finally {
      run?.kill('SIGKILL')
      await feed.close()
      await rm(baseDir, { recursive: true, force: true })
    }
  })
})

// --- Shared helpers ----------------------------------------------------------

function manifestBytes(options: {
  releaseBytes: Buffer
  releaseSig: string
  signingKeyCert: ReturnType<typeof signSigningKeyCert>
  artifactUrl: string
}): Buffer {
  return Buffer.from(JSON.stringify(buildManifest(options)))
}

/** WebAuthn must be wired up BEFORE the first navigation that calls `navigator.credentials.create`/`.get` -- same rationale as `local-vps.spec.ts`. */
async function addVirtualAuthenticator(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  expect(authenticatorId).toBeTruthy()
}

/** Registers the passkey and walks the onboarding wizard with defaults, landing on Home -- the same journey `local-vps.spec.ts` establishes, condensed (no chat/fast-path demo, which that spec already covers). */
async function onboardMinimal(page: Page, stack: LocalVpsStack): Promise<void> {
  const [setup] = await Promise.all([stack.waitForSetupUrl(), stack.waitForReadyLine()])
  await page.goto(setup.url)

  await expect(page.getByRole('button', { name: 'Register passkey' })).toBeVisible()
  await page.getByRole('button', { name: 'Register passkey' }).click()
  await expect(page.getByRole('button', { name: 'Register passkey' })).toBeHidden()

  await expect(page.getByRole('heading', { name: 'Set up Veduta' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue' }).click()
  await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()
  await page.getByRole('button', { name: 'Save & continue' }).click()
  await page.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByRole('button', { name: 'Skip' })).toBeVisible()
  await page.getByRole('button', { name: 'Skip' }).click()
  await expect(page.getByRole('button', { name: 'Finish' })).toBeVisible()
  await page.getByRole('button', { name: 'Finish' }).click()

  await stack.waitForReadyLine()
  await expect(page.getByRole('button', { name: 'Focus Meals' })).toBeVisible({ timeout: 60_000 })
}

async function focusSystemSpace(page: Page): Promise<void> {
  await page
    .getByRole('complementary', { name: 'Spaces' })
    .getByRole('button', { name: 'System' })
    .click()
}

/** The `<article class="surface-card">` for a given Surface, scoped by its unique "Focus <title>" button -- same helper as `local-vps.spec.ts`. */
function surfaceCard(page: Page, title: string) {
  return page.locator('article.surface-card', {
    has: page.getByRole('button', { name: `Focus ${title}` }),
  })
}

async function authToken(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('veduta.authToken'))
}

interface SpaceEventEntry {
  type: string
  text: string
  payload?: { outcome?: string; reason?: string; failedStage?: string; resultId?: string }
}

/** Reads a Space's Event log (ADR-0003) the way the PWA would -- same pattern as `local-vps.spec.ts`'s `fetchSpaceEvents`, generalized over `spaceId` since this suite reads both `spc-health` and `spc-system`. */
async function fetchSpaceEvents(
  page: Page,
  origin: string,
  spaceId: string,
): Promise<SpaceEventEntry[]> {
  const token = await authToken(page)
  const response = await page.request.get(`${origin}/api/spaces/${spaceId}/events`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  expect(response.ok()).toBe(true)
  const body = (await response.json()) as { events: SpaceEventEntry[] }
  return body.events
}

interface HealthResponse {
  ok: boolean
  version: string
  dataVersion: number
}

/** `/api/health` is auth-gated in production mode (`server.ts`'s `isPublicUnauthenticatedPath`) -- returns `undefined` on any non-2xx response rather than throwing, so callers can poll through a restart window where the daemon is briefly down. */
async function fetchHealth(page: Page, origin: string): Promise<HealthResponse | undefined> {
  const token = await authToken(page)
  try {
    const response = await page.request.get(`${origin}/api/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!response.ok()) return undefined
    return (await response.json()) as HealthResponse
  } catch {
    return undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- AC4's raw wrapper-process helper (no browser, no `LocalVpsStack`) ------

const READY_LINE = /^veduta daemon \(local vps profile\) -> http:\/\/localhost:(\d+)$/

interface DirectRun {
  waitForReadyLine(timeoutMs?: number): Promise<void>
  kill(signal: NodeJS.Signals): void
  readonly exited: Promise<number | null>
}

/**
 * Spawns `deploy/veduta-run` directly (not `deploy/local-vps.sh` -- AC4
 * needs no PWA build and no browser at all), as its own process group
 * (`detached: true`, mirroring `stack.ts`'s own rationale: the negative pid
 * below must reach the whole tree, not just the top-level bash process).
 * Deliberately minimal next to `stack.ts`'s `LocalVpsStack`: this helper
 * only ever waits for a single ready line per instance and exposes a raw
 * `kill`, which is exactly what AC4's hard-kill needs and `LocalVpsStack`
 * intentionally does not expose (its own `stop()` is graceful-only, on
 * purpose, for `local-vps.spec.ts`).
 */
function spawnVedutaRunDirect(options: {
  port: number
  dataDir: string
  vaultKeyfile: string
  updateHome: string
  updatePinning: string
  extraEnv?: Record<string, string>
}): DirectRun {
  const env = { ...process.env }
  delete env['VEDUTA_AUTH_STATE']
  delete env['VEDUTA_VAULT_KEY']
  Object.assign(env, {
    VEDUTA_PROFILE: 'local-vps',
    VEDUTA_DATA_DIR: options.dataDir,
    VEDUTA_VAULT_KEYFILE: options.vaultKeyfile,
    PORT: String(options.port),
    VEDUTA_UPDATE_HOME: options.updateHome,
    VEDUTA_UPDATE_PINNING: options.updatePinning,
    VEDUTA_LEGACY_ROOT: REPO_ROOT,
    ...options.extraEnv,
  })

  const child: ChildProcess = spawn(VEDUTA_RUN_SCRIPT, [], {
    cwd: REPO_ROOT,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let readyReceived = false
  let resolveReady: (() => void) | undefined
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = () => {
      readyReceived = true
      resolve()
    }
  })

  const onLine = (source: 'stdout' | 'stderr', line: string) => {
    console.log(`[selfupdate-ac4-direct ${source}:${options.port}] ${line}`)
    if (!readyReceived && READY_LINE.test(line)) resolveReady?.()
  }
  createInterface({ input: child.stdout! }).on('line', (line) => onLine('stdout', line))
  createInterface({ input: child.stderr! }).on('line', (line) => onLine('stderr', line))

  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code))
  })

  const waitForReadyLine = (timeoutMs = 180_000): Promise<void> =>
    Promise.race([
      readyPromise,
      new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for the ready line')), timeoutMs)
      }),
    ])

  const kill = (signal: NodeJS.Signals): void => {
    const pid = child.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, signal)
    } catch {
      // Already gone.
    }
  }

  return { waitForReadyLine, kill, exited }
}
