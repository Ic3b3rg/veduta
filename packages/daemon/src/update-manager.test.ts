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
import { generateKeypair, sign, type GeneratedKeypair } from './update/minisign.ts'
import { resolveUpdateHome } from './update/update-transaction.ts'
import { UpdateManager, type UpdateManagerConfig } from './update-manager.ts'
import { UPDATE_SURFACE_ID } from './update-surface.ts'

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

/** Rebuilds `feedBody` with a fresh signing key certified by the fixture's fixed `root` keypair — the root (and therefore the pinning file already on disk) never changes within a test. */
function serveRelease(release: ReleaseMetadata, options?: { corruptReleaseSig?: boolean }): void {
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
    trustedComment: release.artifactName,
  })
  if (options?.corruptReleaseSig) releaseSigText = tamperBase64Line(releaseSigText, 1)
  feedBody = JSON.stringify({
    schemaVersion: 1,
    release: releaseBytes.toString('base64'),
    releaseSig: releaseSigText,
    signingKey: { pub: signing.publicKeyText, rootSig: signingCertText, keyId: 'test-key' },
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
    expect(failure?.text).toMatch(/^check failed:/)
    expect(failure?.origin).toBe('trusted:system')
    expect(events.some((event) => event.type === 'update.available')).toBe(false)

    const surface = store.getSurface(UPDATE_SURFACE_ID)
    expect(findNode(surface!.tree, 'update-apply-button')).toBeUndefined()
    expect(notifications).toHaveLength(0)
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
})
