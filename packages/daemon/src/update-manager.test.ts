import { createServer, type Server } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  UpdateMarkerSchema,
  type AtomNode,
  type ReleaseMetadata,
  type UpdatePinning,
  type UpdateResult,
} from '@veduta/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Scheduler } from './scheduler.ts'
import { Store } from './store.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'
import { untrustedOrigin } from './taint.ts'
import { generateKeypair, publicKeyIdText, sign, type GeneratedKeypair } from './update/minisign.ts'
import { resolveUpdateHome } from './update/update-transaction.ts'
import { UpdateManager, type UpdateManagerConfig } from './update-manager.ts'
import { UPDATE_CHECK_STATE_KEY, UPDATE_SURFACE_ID } from './update-surface.ts'

function findNode(node: AtomNode, id: string): AtomNode | undefined {
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

/** Flips one non-padding base64 character in `text`'s line `lineIndex`, keeping it well-formed base64 (so it still parses) but decoding to different bytes — the minisign-format equivalent of "tampered signature". */
function tamperBase64Line(text: string, lineIndex: number): string {
  const lines = text.split('\n')
  const line = lines[lineIndex]
  if (line === undefined || line.length < 2) {
    throw new Error(`tamperBase64Line: line ${lineIndex} too short to tamper`)
  }
  const chars = line.split('')
  const target = chars[1]
  chars[1] = target === 'A' ? 'B' : 'A'
  lines[lineIndex] = chars.join('')
  return lines.join('\n')
}

function defaultRelease(overrides: Partial<ReleaseMetadata> = {}): ReleaseMetadata {
  return {
    version: '1.1.0',
    artifactName: 'veduta-v1.1.0-linux.tar.gz',
    sha256: 'a'.repeat(64),
    artifactSize: 100,
    unpackedSize: 100,
    entryCount: 1,
    dataVersion: 1,
    nodeVersion: '24.0.0',
    nodeTarSize: 1,
    nodeUnpackedSize: 1,
    notes: 'release notes from the feed',
    ...overrides,
  }
}

let rootDir: string
let updateHomeDir: string
let dataRootDir: string
let clock: Date
const now = () => new Date(clock.getTime())

let store: Store
let scheduler: Scheduler
let server: Server
let feedBody = ''
let pinningPath: string
let root: GeneratedKeypair
let notifications: { level: string; spaceId: string; text: string; origin?: string }[]
let scheduleExitCalls: number
let manager: UpdateManager

/**
 * Rebuilds `feedBody` with a fresh signing key certified by the fixture's
 * fixed `root` keypair — the root (and therefore the pinning file already on
 * disk) never changes within a test. `keyId` is the real minisign-convention
 * text derived from the signing key itself (`publicKeyIdText`), not an
 * arbitrary label: `UpdateManager.runCheck` verifies it against the
 * certified key's actual id, so a mismatched manifest `keyId` must be
 * produceable by `options.keyId` for the refusal test to exercise anything
 * real. `trustedComment` overrides what the release signature is actually
 * signed for, independent of `release.artifactName` — used to simulate a
 * feed claiming a hostile name/comment the daemon never asked for.
 */
function serveRelease(
  release: ReleaseMetadata,
  options?: { corruptReleaseSig?: boolean; trustedComment?: string; keyId?: string },
): void {
  const signing = generateKeypair()
  const signingCertText = sign({
    contentBytes: Buffer.from(signing.publicKeyText, 'utf8'),
    secretKey: root.secretKey,
    trustedComment: 'signing.pub',
  })
  const releaseBytes = Buffer.from(JSON.stringify(release), 'utf8')
  let releaseSigText = sign({
    contentBytes: releaseBytes,
    secretKey: signing.secretKey,
    trustedComment: options?.trustedComment ?? release.artifactName,
  })
  if (options?.corruptReleaseSig) releaseSigText = tamperBase64Line(releaseSigText, 1)
  feedBody = JSON.stringify({
    schemaVersion: 1,
    release: releaseBytes.toString('base64'),
    releaseSig: releaseSigText,
    signingKey: {
      pub: signing.publicKeyText,
      rootSig: signingCertText,
      keyId: options?.keyId ?? publicKeyIdText(signing.publicKeyText),
    },
    artifactUrl: 'http://127.0.0.1:1/artifact.tar.gz',
  })
}

function buildManager(overrides: Partial<UpdateManagerConfig> = {}): UpdateManager {
  return new UpdateManager({
    store,
    scheduler,
    notifications: {
      notify: (input) => notifications.push(input as (typeof notifications)[number]),
    },
    config: {
      updateHome: updateHomeDir,
      pinningPath,
      dataRootDir,
      scheduleExit: () => {
        scheduleExitCalls += 1
      },
      now,
      installedVersion: '1.0.0',
      pollIntervalMs: 50,
      ...overrides,
    },
  })
}

beforeEach(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-update-manager-'))
  updateHomeDir = mkdtempSync(join(tmpdir(), 'veduta-update-home-'))
  dataRootDir = mkdtempSync(join(tmpdir(), 'veduta-update-data-'))
  clock = new Date('2026-08-05T06:30:00.000Z')
  notifications = []
  scheduleExitCalls = 0

  store = new Store({ rootDir, now })
  ensureSystemSpace(store.spacesEngine)
  scheduler = new Scheduler({ rootDir, store, now })

  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(feedBody)
  })
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise()))
  const port = (server.address() as AddressInfo).port

  root = generateKeypair()
  const pinning: UpdatePinning = {
    feedUrl: `http://127.0.0.1:${port}/stable.json`,
    rootPublicKey: root.publicKeyText,
  }
  pinningPath = join(rootDir, 'update.json')
  writeFileSync(pinningPath, JSON.stringify(pinning))
  serveRelease(defaultRelease())

  manager = buildManager()
})

afterEach(async () => {
  manager.dispose()
  scheduler.stop()
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()))
  rmSync(rootDir, { recursive: true, force: true })
  rmSync(updateHomeDir, { recursive: true, force: true })
  rmSync(dataRootDir, { recursive: true, force: true })
})

describe('UpdateManager.register', () => {
  it('pre-creates the Update Surface and reconciles the daily check-updates job', () => {
    manager.register()
    expect(store.getSurface(UPDATE_SURFACE_ID)).toBeDefined()
    const jobs = scheduler
      .listAutomations(SYSTEM_SPACE_ID)
      .filter((automation) => automation.handler === 'check-updates')
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.status).toBe('armed')
  })
})

describe('UpdateManager.runCheck', () => {
  it('discovers a newer, verified offer: Surface updated, event appended with untrusted origin, badge notified', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0', dataVersion: 1, notes: 'Bug fixes' }))

    const outcome = await manager.runCheck('manual')
    expect(outcome).toBe('update-available:1.1.0')

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-available-stat')?.props?.['value']).toBe('1.1.0')
    expect(findNode(surface!.tree, 'update-available-notes')?.props?.['text']).toBe('Bug fixes')
    // dataVersion 1 > installed (no data-version.json in dataRootDir => 0)
    expect(findNode(surface!.tree, 'update-migrates-caption')).toBeDefined()
    expect(findNode(surface!.tree, 'update-apply-button')).toBeDefined()

    const events = store.eventLog(SYSTEM_SPACE_ID)
    const offer = events.find((event) => event.type === 'update.available')
    expect(offer?.origin).toBe(untrustedOrigin('update-feed'))
    expect(offer?.payload?.['version']).toBe('1.1.0')

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({
      level: 'badge',
      spaceId: SYSTEM_SPACE_ID,
      origin: untrustedOrigin('update-feed'),
    })
  })

  it('records lastCheckedAt only (no event, no offer) when the offered version is not newer', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.0.0' })) // equals installedVersion

    const outcome = await manager.runCheck('manual')
    expect(outcome).toBe('no-update-available')

    const events = store.eventLog(SYSTEM_SPACE_ID)
    expect(events.some((event) => event.type === 'update.available')).toBe(false)
    expect(events.some((event) => event.type === 'update.check')).toBe(false)
    expect(notifications).toHaveLength(0)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-apply-button')).toBeUndefined()
  })

  it('a broken signature chain is refused as a failed check, never an offer', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }), { corruptReleaseSig: true })

    const outcome = await manager.runCheck('manual')
    expect(outcome).toMatch(/^check-failed:/)

    const events = store.eventLog(SYSTEM_SPACE_ID)
    const failure = events.find((event) => event.type === 'update.check')
    // The Event's own text is a fixed, daemon-authored summary — never the
    // raw error message, which can embed feed-controlled bytes.
    expect(failure?.text).toBe('update check failed')
    expect(failure?.origin).toBe(untrustedOrigin('update-feed'))
    expect(typeof failure?.payload?.['reason']).toBe('string')
    expect(events.some((event) => event.type === 'update.available')).toBe(false)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-apply-button')).toBeUndefined()
    expect(notifications).toHaveLength(0)
  })

  it('clears the one-shot Check-now state after handling it, so a second tap is a real mutation the store still notifies on', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }))

    const surfaceBefore = store.getSurface(UPDATE_SURFACE_ID)
    expect(surfaceBefore!.state[UPDATE_CHECK_STATE_KEY]).toBe(false)

    store.invokeSurfaceAction(UPDATE_SURFACE_ID, {
      nodeId: 'update-check-button',
      name: 'check',
      payload: { value: true },
    })
    await vi.waitFor(() => {
      const surface = store.getSurface(UPDATE_SURFACE_ID)
      expect(surface!.state[UPDATE_CHECK_STATE_KEY]).toBe(false)
    })
  })

  it('offers an update on a good check that follows a failed one, so one bad feed response never latches the Surface shut', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }), { corruptReleaseSig: true })
    await manager.runCheck('manual')

    serveRelease(defaultRelease({ version: '1.1.0' }))
    const outcome = await manager.runCheck('manual')

    expect(outcome).not.toMatch(/^check-failed:/)
    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-apply-button')).toBeDefined()
  })

  it('a hostile artifact name/trusted comment in a failed check is recorded under an untrusted origin, in the Event and the Surface alike', async () => {
    manager.register()
    // No offer has ever been shown on this Surface yet, so its persisted
    // content_origin starts trusted (`ensureSurface`'s first `refreshSurface`)
    // — this is the case the fix must cover: no `available` to fall back on
    // for `updateSurfaceContentOrigin` to mark untrusted on its own.
    expect(store.surfaceProvenance(UPDATE_SURFACE_ID)?.contentOrigin).toBe('trusted:system')

    const hostileComment = "'; DROP TABLE releases; -- <script>alert(1)</script>"
    serveRelease(defaultRelease({ version: '1.1.0' }), { trustedComment: hostileComment })

    const outcome = await manager.runCheck('manual')
    expect(outcome).toMatch(/^check-failed:/)

    const failure = store.eventLog(SYSTEM_SPACE_ID).find((event) => event.type === 'update.check')
    expect(failure?.origin).toBe(untrustedOrigin('update-feed'))
    expect(failure?.text).toBe('update check failed')
    expect(String(failure?.payload?.['reason'])).toContain(hostileComment)

    expect(store.surfaceProvenance(UPDATE_SURFACE_ID)?.contentOrigin).toBe(
      untrustedOrigin('update-feed'),
    )
  })

  it('a manifest whose declared signingKey.keyId does not match the certified key is refused at check time', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }), { keyId: 'DEADBEEFDEADBEEF' })

    const outcome = await manager.runCheck('manual')
    expect(outcome).toMatch(/^check-failed:/)

    const events = store.eventLog(SYSTEM_SPACE_ID)
    const failure = events.find((event) => event.type === 'update.check')
    expect(String(failure?.payload?.['reason'])).toMatch(/signing key id mismatch/)
    expect(events.some((event) => event.type === 'update.available')).toBe(false)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-apply-button')).toBeUndefined()
  })

  it('a check failure while a prior apply Badge is showing leaves the Badge tone and text untouched', async () => {
    manager.register()

    // Simulate an already-terminal 'applied' outcome on the Surface, the
    // same shape `ingestResult` leaves behind.
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const result: UpdateResult = {
      id: 'result-applied',
      outcome: 'success',
      fromVersion: '1.0.0',
      toVersion: '1.0.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(result))
    manager.start()
    await vi.waitFor(() => {
      const surface = store.getSurface(UPDATE_SURFACE_ID)
      expect(findNode(surface!.tree, 'update-outcome-badge')?.props?.['text']).toBe(
        'Updated to 1.0.0',
      )
    })

    serveRelease(defaultRelease({ version: '1.1.0' }), { corruptReleaseSig: true })
    const outcome = await manager.runCheck('manual')
    expect(outcome).toMatch(/^check-failed:/)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    const badge = findNode(surface!.tree, 'update-outcome-badge')
    expect(badge?.props?.['text']).toBe('Updated to 1.0.0')
    expect(badge?.props?.['tone']).toBe('success')
  })
})

describe('UpdateManager.applyUpdate', () => {
  it('re-verifies, writes a schema-valid marker, moves the Surface to updating, and schedules the exit', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0', dataVersion: 1 }))

    await manager.applyUpdate()

    const home = resolveUpdateHome(updateHomeDir)
    const markerPath = join(home.stateDir, 'marker.json')
    expect(existsSync(markerPath)).toBe(true)
    const marker = UpdateMarkerSchema.parse(JSON.parse(readFileSync(markerPath, 'utf8')))
    expect(marker.artifactUrl).toBe('http://127.0.0.1:1/artifact.tar.gz')

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-apply-button')).toBeUndefined()
    expect(findNode(surface!.tree, 'update-outcome-caption')?.props?.['text']).toBe(
      'Applying update…',
    )

    const applyEvent = store
      .eventLog(SYSTEM_SPACE_ID)
      .find((event) => event.type === 'update.apply')
    expect(applyEvent?.origin).toBe('trusted:user')

    expect(scheduleExitCalls).toBe(1)
  })

  it('never applies a stale offer: no marker and no exit when the re-check finds nothing newer', async () => {
    manager.register()
    await manager.runCheck('manual') // records the offer at 1.1.0
    serveRelease(defaultRelease({ version: '1.0.0' })) // the feed no longer offers anything newer

    await manager.applyUpdate()

    const home = resolveUpdateHome(updateHomeDir)
    expect(existsSync(join(home.stateDir, 'marker.json'))).toBe(false)
    expect(scheduleExitCalls).toBe(0)
  })

  it('refuses outright, honestly, while an update journal is already active — never writing a second marker on top of it', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }))

    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    writeFileSync(join(home.stateDir, 'update-state.json'), JSON.stringify({ phase: 'migrating' }))

    await manager.applyUpdate()

    expect(existsSync(join(home.stateDir, 'marker.json'))).toBe(false)
    expect(scheduleExitCalls).toBe(0)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    const badge = findNode(surface!.tree, 'update-outcome-badge')
    expect(badge?.props?.['text']).toBe('an update is already in progress')
    expect(badge?.props?.['tone']).toBe('danger')
  })

  it('refuses outright, honestly, while a result is unswept — never writing a second marker on top of it', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }))

    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const result: UpdateResult = {
      id: 'result-unswept',
      outcome: 'success',
      fromVersion: '0.9.0',
      toVersion: '1.0.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(result))

    await manager.applyUpdate()

    expect(existsSync(join(home.stateDir, 'marker.json'))).toBe(false)
    expect(scheduleExitCalls).toBe(0)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    const badge = findNode(surface!.tree, 'update-outcome-badge')
    expect(badge?.props?.['text']).toBe('an update is already in progress')
    expect(badge?.props?.['tone']).toBe('danger')
  })

  it('sweeps a fully-acked previous result before applying, so a second update is never permanently blocked', async () => {
    manager.register()
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const priorResult: UpdateResult = {
      id: 'result-acked-prior',
      outcome: 'success',
      fromVersion: '0.9.0',
      toVersion: '1.0.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(priorResult))
    writeFileSync(join(home.stateDir, `result-acked-${priorResult.id}`), '')

    serveRelease(defaultRelease({ version: '1.1.0' }))
    await manager.applyUpdate()

    // The acked result is archived, not left behind to block this (or any
    // future) apply forever.
    expect(existsSync(join(home.stateDir, 'result.json'))).toBe(false)
    expect(existsSync(join(home.stateDir, `result-acked-${priorResult.id}`))).toBe(false)

    expect(existsSync(join(home.stateDir, 'marker.json'))).toBe(true)
    expect(scheduleExitCalls).toBe(1)
  })

  it('two consecutive updates in a row succeed at the manager level: apply, boot-ingest+ack, apply again', async () => {
    manager.register()
    serveRelease(defaultRelease({ version: '1.1.0' }))
    await manager.applyUpdate()

    const home = resolveUpdateHome(updateHomeDir)
    expect(existsSync(join(home.stateDir, 'marker.json'))).toBe(true)
    expect(scheduleExitCalls).toBe(1)

    // Simulate the wrapper's transaction consuming the marker and completing
    // successfully, then the (now new-version) daemon booting and finding
    // `result.json` — the same handoff `update-transaction.ts`/`update-cli.ts`
    // perform for real.
    rmSync(join(home.stateDir, 'marker.json'), { force: true })
    const firstResult: UpdateResult = {
      id: 'result-first-update',
      outcome: 'success',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(firstResult))

    const booted = buildManager({ installedVersion: '1.1.0' })
    booted.register()
    booted.start()
    await vi.waitFor(() => {
      expect(existsSync(join(home.stateDir, `result-acked-${firstResult.id}`))).toBe(true)
    })

    // A second update, offered to the now-running (post-first-update) daemon,
    // must not be permanently blocked by the first update's own (now fully
    // acked) result.
    serveRelease(defaultRelease({ version: '1.2.0' }))
    await booted.applyUpdate()

    expect(existsSync(join(home.stateDir, 'result.json'))).toBe(false)
    expect(existsSync(join(home.stateDir, 'marker.json'))).toBe(true)
    expect(scheduleExitCalls).toBe(2)

    booted.dispose()
  })
})

describe('UpdateManager boot-time result ingestion', () => {
  it('ingests a pre-existing result.json durably and idempotently on repeat boots', () => {
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const result: UpdateResult = {
      id: 'result-1',
      outcome: 'success',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(result))

    const booted = buildManager({ installedVersion: '1.1.0' })
    booted.register()
    booted.start()

    const events = store.eventLog(SYSTEM_SPACE_ID)
    const outcomeEvent = events.find((event) => event.type === 'update.outcome')
    expect(outcomeEvent?.payload?.['resultId']).toBe('result-1')
    expect(outcomeEvent?.origin).toBe('trusted:system')

    expect(existsSync(join(home.stateDir, 'result-acked-result-1'))).toBe(true)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-outcome-badge')?.props?.['tone']).toBe('success')
    expect(notifications.some((notification) => notification.level === 'badge')).toBe(true)

    // result.json is never deleted/moved by the daemon.
    expect(existsSync(join(home.stateDir, 'result.json'))).toBe(true)

    // A second boot ingesting the same still-present result.json is a no-op (dedupe on the Event log).
    const before = store
      .eventLog(SYSTEM_SPACE_ID)
      .filter((event) => event.type === 'update.outcome').length
    booted.start()
    const after = store
      .eventLog(SYSTEM_SPACE_ID)
      .filter((event) => event.type === 'update.outcome').length
    expect(after).toBe(before)

    booted.dispose()
  })

  it('polls for a result while a non-terminal journal is present, ingesting once the wrapper publishes it', async () => {
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    writeFileSync(
      join(home.stateDir, 'update-state.json'),
      JSON.stringify({ phase: 'serving-check' }),
    )

    const booted = buildManager({ installedVersion: '1.1.0' })
    booted.register()
    booted.start()

    expect(store.eventLog(SYSTEM_SPACE_ID).some((event) => event.type === 'update.outcome')).toBe(
      false,
    )

    const result: UpdateResult = {
      id: 'result-2',
      outcome: 'rolled-back',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: 'stage-1 self-check failed',
      finishedAt: now().toISOString(),
      failedStage: 'health',
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(result))

    await vi.waitFor(
      () => {
        expect(
          store.eventLog(SYSTEM_SPACE_ID).some((event) => event.type === 'update.outcome'),
        ).toBe(true)
      },
      { timeout: 5000, interval: 25 },
    )

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-outcome-badge')?.props?.['tone']).toBe('danger')

    booted.dispose()
  })

  it('a day-log fsync failure leaves the ack unwritten and result.json untouched, for the next boot to retry', async () => {
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const result: UpdateResult = {
      id: 'result-fsync-fail',
      outcome: 'success',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    const resultFile = join(home.stateDir, 'result.json')
    writeFileSync(resultFile, JSON.stringify(result))

    const booted = buildManager({ installedVersion: '1.1.0' })
    booted.register()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(
      booted as unknown as { fsyncDayLog: (atIso: string) => void },
      'fsyncDayLog',
    ).mockImplementation(() => {
      throw new Error('simulated day-log fsync failure')
    })

    await (booted as unknown as { ingestResult: (path: string) => Promise<void> }).ingestResult(
      resultFile,
    )

    // No ack, ever — the fix's core guarantee: a failure between the event
    // append and the fsync must not tell the wrapper the outcome is durably
    // recorded when it might not be.
    expect(existsSync(join(home.stateDir, `result-acked-${result.id}`))).toBe(false)
    expect(existsSync(resultFile)).toBe(true)
    expect(notifications.some((notification) => notification.level === 'badge')).toBe(false)

    errorSpy.mockRestore()
    booted.dispose()
  })

  it('a crash between the event append and the ack (simulated by a throwing ack write) is recovered by a second ingestion: exactly one event, Surface/badge completed, ack written', async () => {
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const result: UpdateResult = {
      id: 'result-crash-after-event',
      outcome: 'success',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: '',
      finishedAt: now().toISOString(),
    }
    const resultFile = join(home.stateDir, 'result.json')
    writeFileSync(resultFile, JSON.stringify(result))

    const booted = buildManager({ installedVersion: '1.1.0' })
    booted.register()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ingest = (
      booted as unknown as { ingestResult: (path: string) => Promise<void> }
    ).ingestResult.bind(booted)
    vi.spyOn(
      booted as unknown as { writeAckFile: (id: string) => void },
      'writeAckFile',
    ).mockImplementationOnce(() => {
      throw new Error('simulated crash before the ack file was durably written')
    })

    await ingest(resultFile)

    // First attempt: the event was appended and the Surface/badge were
    // patched — only the (simulated) crash on the ack write was withheld.
    expect(existsSync(join(home.stateDir, `result-acked-${result.id}`))).toBe(false)
    expect(
      store.eventLog(SYSTEM_SPACE_ID).filter((event) => event.type === 'update.outcome'),
    ).toHaveLength(1)
    expect(notifications.filter((notification) => notification.level === 'badge')).toHaveLength(1)

    // Second attempt: the event already exists (the dedupe path), so it is
    // never appended twice — but the ack is still missing, so this call must
    // (re-)ensure the Surface/badge exist before finally acking.
    await ingest(resultFile)

    expect(existsSync(join(home.stateDir, `result-acked-${result.id}`))).toBe(true)
    expect(
      store.eventLog(SYSTEM_SPACE_ID).filter((event) => event.type === 'update.outcome'),
    ).toHaveLength(1)
    // The notify-dedupe fix's core guarantee: two ingest attempts for the
    // same result id never produce more than one notification, even though
    // the second attempt still re-ensures the Surface/badge state.
    expect(notifications.filter((notification) => notification.level === 'badge')).toHaveLength(1)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-outcome-badge')?.props?.['tone']).toBe('success')

    errorSpy.mockRestore()
    booted.dispose()
  })

  it('an ingested rolled-back result whose reason carries hostile feed/candidate-derived text is recorded and rendered under an untrusted origin', async () => {
    const home = resolveUpdateHome(updateHomeDir)
    mkdirSync(home.stateDir, { recursive: true })
    const hostileReason =
      "stage-1 self-check failed: '; DROP TABLE releases; -- <script>alert(1)</script>"
    const result: UpdateResult = {
      id: 'result-hostile-reason',
      outcome: 'rolled-back',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: hostileReason,
      finishedAt: now().toISOString(),
      failedStage: 'health',
    }
    writeFileSync(join(home.stateDir, 'result.json'), JSON.stringify(result))

    const booted = buildManager({ installedVersion: '1.1.0' })
    booted.register()
    booted.start()

    await vi.waitFor(() => {
      expect(existsSync(join(home.stateDir, `result-acked-${result.id}`))).toBe(true)
    })

    const event = store
      .eventLog(SYSTEM_SPACE_ID)
      .find((candidate) => candidate.type === 'update.outcome')
    expect(event?.origin).toBe(untrustedOrigin('update-feed'))
    // The Event's own text stays a fixed, daemon-authored summary — never
    // the raw reason, which can embed feed/candidate-controlled bytes.
    expect(event?.text).toBe('Update to 1.1.0: rolled-back')
    expect(event?.payload?.['reason']).toBe(hostileReason)

    expect(store.surfaceProvenance(UPDATE_SURFACE_ID)?.contentOrigin).toBe(
      untrustedOrigin('update-feed'),
    )

    booted.dispose()
  })
})
