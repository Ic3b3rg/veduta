import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  ReleaseMetadataSchema,
  UpdateManifestSchema,
  UpdateMarkerSchema,
  UpdatePinningSchema,
  UpdateResultSchema,
  type ReleaseMetadata,
  type UpdateManifest,
  type UpdateMarker,
  type UpdatePinning,
  type UpdateResult,
} from '@veduta/protocol'
import { timeToCron } from './cron.ts'
import { reconcileManagedJobs } from './managed-jobs.ts'
import type { NotificationInput } from './notification-center.ts'
import type { Scheduler } from './scheduler.ts'
import type { SpaceEvent } from './spaces-engine.ts'
import type { FastMutationNotice, Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { untrustedOrigin, type Origin } from './taint.ts'
import { checkMonotonic, verifyReleaseChain } from './update/minisign.ts'
import { readDataVersion } from './update/data-version.ts'
import { resolveUpdateHome, type UpdateHome } from './update/update-transaction.ts'
import {
  availableSlotNode,
  buttonsRowNode,
  currentStatNode,
  outcomeSlotNode,
  outcomeTone,
  UPDATE_APPLY_STATE_KEY,
  UPDATE_CHECK_STATE_KEY,
  UPDATE_SURFACE_ID,
  updateSurface,
  updateSurfaceContentOrigin,
  type UpdateSurfaceView,
} from './update-surface.ts'
import { compareVersions, VEDUTA_VERSION } from './version.ts'

/** `check-updates`'s daily managed-job time-of-day (UTC), same idiom as the Heartbeat's own configured sweep times (`heartbeat-config.ts`). */
const DAILY_CHECK_TIME = '06:30'

/** Feed responses are capped well below anything a legitimate `stable.json` + embedded release metadata needs. */
const MAX_FEED_BYTES = 1024 * 1024

const FEED_TIMEOUT_MS = 15_000

/** How often `start()`'s boot-time poll re-checks for `state/result.json` while a non-terminal journal is present (we are the stage-2 candidate the wrapper is watching). */
const RESULT_POLL_INTERVAL_MS = 2_000

/** Stop polling for a result after this long — the wrapper is expected to publish one well within this window; giving up avoids polling forever if the wrapper itself died. */
const RESULT_POLL_TIMEOUT_MS = 10 * 60 * 1000

export interface UpdateManagerConfig {
  /** `/var/lib/veduta/updates` on a real install (`VEDUTA_UPDATE_HOME`); a throwaway directory in tests. */
  updateHome: string
  /** Path to the root-owned pinning file (`VEDUTA_UPDATE_PINNING`, `/etc/veduta/update.json` on a real install): `{feedUrl, rootPublicKey}`. */
  pinningPath: string
  dataRootDir: string
  /** Fired once `applyUpdate` has written the marker — the daemon's own graceful-exit hook (issue #43's dedicated code 75, `docs/adr/0013-signed-self-update.md`), never invoked directly by tests. */
  scheduleExit: () => void
  fetchImpl?: typeof fetch
  now?: () => Date
  /**
   * The version this running daemon offers as "installed" when comparing
   * against a feed offer. Defaults to `VEDUTA_VERSION` (`version.ts`) — the
   * real production/e2e wiring never overrides this. Tests override it
   * because `VEDUTA_VERSION` stays the literal placeholder `'0.0.0-dev'` in
   * every dev/test process (by design — only a release build stamps a real
   * `x.y.z`), which `compareVersions`/`checkMonotonic` (both strict `x.y.z`
   * parsers) cannot parse; overriding it here is the same dependency-
   * injection idiom as `fetchImpl`/`now`, not a behavior change for any real
   * deployment.
   */
  installedVersion?: string
  /** Test-only override for `start()`'s boot-time result-poll interval (production always uses `RESULT_POLL_INTERVAL_MS`) — lets a polling test resolve in milliseconds instead of seconds. */
  pollIntervalMs?: number
}

export interface UpdateManagerOptions {
  store: Store
  scheduler: Scheduler
  notifications: { notify(input: NotificationInput): void }
  config: UpdateManagerConfig
}

/** A release offer this process has itself verified against the pinned root of trust — set only by a `runCheck` that both confirmed a newer version and passed `verifyReleaseChain`. Re-verified at apply time by calling `runCheck` again first (never acting on a stale offer). */
interface VerifiedOffer {
  manifest: UpdateManifest
  metadata: ReleaseMetadata
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function journalFilePath(home: UpdateHome): string {
  return join(home.stateDir, 'update-state.json')
}

function resultFilePath(home: UpdateHome): string {
  return join(home.stateDir, 'result.json')
}

function ackFilePath(home: UpdateHome, id: string): string {
  return join(home.stateDir, `result-acked-${id}`)
}

/** Same tmp+fsync+rename+dir-fsync idiom as `update-transaction.ts`'s `writeJsonAtomic` — the daemon's own write into the update home (the marker), so a crash never leaves a half-written file for the wrapper to read. */
function writeJsonAtomic(dir: string, filename: string, data: unknown): void {
  mkdirSync(dir, { recursive: true })
  const path = join(dir, filename)
  const tmpPath = `${path}.tmp`
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(data, null, 2)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
  const dirFd = openSync(dir, fsConstants.O_RDONLY)
  try {
    fsyncSync(dirFd)
  } finally {
    closeSync(dirFd)
  }
}

/** Reads the response body up to `maxBytes`, aborting past the cap — never buffers an unbounded feed response. */
async function fetchCapped(
  fetchImpl: typeof fetch,
  url: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`update feed fetch failed: HTTP ${response.status} from ${url}`)
    }
    if (!response.body) {
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxBytes) {
        throw new Error(`update feed response from ${url} exceeded ${maxBytes} bytes`)
      }
      return bytes
    }
    const reader = response.body.getReader()
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.length
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`update feed response from ${url} exceeded ${maxBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * UpdateManager (issue #43, `docs/adr/0013-signed-self-update.md`): the
 * daemon-side half of self-update discovery and application. Daily and
 * manual checks fetch `stable.json`, verify the full minisign chain, and
 * enforce monotonicity independent of feed contents (`update/minisign.ts`)
 * before ever offering a release on the Update Surface (`update-surface.ts`).
 * "Apply" writes the marker the wrapper's transaction (`update/
 * update-transaction.ts`) consumes on the daemon's next restart, and exits
 * with the dedicated code the wrapper watches for. Boot-time result
 * ingestion closes the loop: whichever daemon comes back up (the new
 * release on success, the old one on refusal/rollback) durably records the
 * outcome exactly once, no matter how many times it is asked to.
 *
 * Constructed by `server.ts` only when both `VEDUTA_UPDATE_HOME` and
 * `VEDUTA_UPDATE_PINNING` are set and the pinning file parses — otherwise
 * self-update is simply not wired, with zero behavior change for every
 * other profile.
 */
export class UpdateManager {
  private readonly store: Store
  private readonly scheduler: Scheduler
  private readonly notifications: { notify(input: NotificationInput): void }
  private readonly config: UpdateManagerConfig
  private readonly home: UpdateHome
  private readonly pinning: UpdatePinning
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly installedVersion: string
  private readonly pollIntervalMs: number

  private currentView: UpdateSurfaceView
  private verifiedOffer: VerifiedOffer | undefined
  private disposeFastMutation: (() => void) | undefined
  private pollTimer: NodeJS.Timeout | undefined

  constructor(options: UpdateManagerOptions) {
    this.store = options.store
    this.scheduler = options.scheduler
    this.notifications = options.notifications
    this.config = options.config
    this.home = resolveUpdateHome(options.config.updateHome)
    this.fetchImpl = options.config.fetchImpl ?? fetch
    this.now = options.config.now ?? (() => new Date())
    this.installedVersion = options.config.installedVersion ?? VEDUTA_VERSION
    this.pollIntervalMs = options.config.pollIntervalMs ?? RESULT_POLL_INTERVAL_MS
    this.pinning = UpdatePinningSchema.parse(
      JSON.parse(readFileSync(options.config.pinningPath, 'utf8')),
    )
    this.currentView = { currentVersion: this.installedVersion, status: 'idle' }
  }

  /**
   * Registers the daily "Check for updates" Automation, pre-creates the
   * Update Surface, and wires the Surface's two fast actions. Call before
   * `scheduler.start()`, same ordering rule as `Heartbeat.register()`/
   * `reconcileJobs()`.
   */
  register(): void {
    this.scheduler.registerHandler('check-updates', () => this.runCheck('automation'))
    reconcileManagedJobs({
      scheduler: this.scheduler,
      spaceId: SYSTEM_SPACE_ID,
      handler: 'check-updates',
      enabled: true,
      desired: new Map([[timeToCron(DAILY_CHECK_TIME), 'Check for updates']]),
    })
    this.ensureSurface()
    this.disposeFastMutation = this.store.onFastMutation((notice) =>
      this.handleFastMutation(notice),
    )
  }

  /**
   * Boot-time result ingestion (`docs/adr/0013-signed-self-update.md`'s
   * R2-4 result-handoff sequence): if `state/result.json` already exists
   * (the daemon that just booted is either the rollback path's old release,
   * or a re-entrant boot after an interrupted ingestion), ingest it
   * immediately. Otherwise, if a non-terminal journal exists (`state/
   * update-state.json` — this daemon *is* the freshly-switched-to release
   * the wrapper's stage 2 is watching), poll for the result the wrapper
   * will publish once its own health window closes. Neither file existing
   * means this daemon did not boot as part of an update transaction at all.
   */
  start(): void {
    const result = resultFilePath(this.home)
    if (existsSync(result)) {
      void this.ingestResult(result)
      return
    }
    if (!existsSync(journalFilePath(this.home))) return

    const deadline = this.now().getTime() + RESULT_POLL_TIMEOUT_MS
    this.pollTimer = setInterval(() => {
      if (existsSync(result)) {
        this.clearPollTimer()
        void this.ingestResult(result)
        return
      }
      if (this.now().getTime() >= deadline) this.clearPollTimer()
    }, this.pollIntervalMs)
    this.pollTimer.unref()
  }

  dispose(): void {
    this.disposeFastMutation?.()
    this.disposeFastMutation = undefined
    this.clearPollTimer()
  }

  private clearPollTimer(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  private handleFastMutation(notice: FastMutationNotice): void {
    if (notice.surfaceId !== UPDATE_SURFACE_ID) return
    if (notice.stateKey === UPDATE_CHECK_STATE_KEY) {
      queueMicrotask(() => {
        this.runCheck('manual')
          .catch((error: unknown) => console.error('update-manager: check failed', error))
          .finally(() => this.resetFastActionKey(UPDATE_CHECK_STATE_KEY))
      })
      return
    }
    if (notice.stateKey === UPDATE_APPLY_STATE_KEY) {
      queueMicrotask(() => {
        this.applyUpdate()
          .catch((error: unknown) => console.error('update-manager: apply failed', error))
          .finally(() => this.resetFastActionKey(UPDATE_APPLY_STATE_KEY))
      })
    }
  }

  /**
   * Fetches and verifies the feed, following the pinned trust chain before
   * ever recording an offer (`docs/adr/0013-signed-self-update.md`): the
   * chain is verified regardless of whether the offered version turns out
   * to be newer, so a tampered/mis-signed feed is always reported as a
   * failed check. The newer-version decision is made with a plain
   * `compareVersions` before `checkMonotonic` runs, rather than by
   * inspecting `checkMonotonic`'s thrown message, so "not newer" (silent —
   * "Surface lastCheckedAt only") and "dataVersion regressed" (a real
   * failure, worth surfacing) are never conflated. Returns a short outcome
   * string, which becomes the `check-updates` Automation's `lastOutcome`
   * when invoked from the scheduler.
   */
  async runCheck(source: 'automation' | 'manual'): Promise<string> {
    this.verifiedOffer = undefined
    try {
      const feedBytes = await fetchCapped(
        this.fetchImpl,
        this.pinning.feedUrl,
        MAX_FEED_BYTES,
        FEED_TIMEOUT_MS,
      )
      const manifest = UpdateManifestSchema.parse(JSON.parse(feedBytes.toString('utf8')))
      const releaseBytes = Buffer.from(manifest.release, 'base64')
      const metadata = ReleaseMetadataSchema.parse(JSON.parse(releaseBytes.toString('utf8')))

      verifyReleaseChain({
        releaseBytes,
        releaseSigText: manifest.releaseSig,
        signingKeyText: manifest.signingKey.pub,
        signingKeyRootSigText: manifest.signingKey.rootSig,
        rootPublicKeyText: this.pinning.rootPublicKey,
        expectedArtifactName: metadata.artifactName,
        expectedSigningKeyId: manifest.signingKey.keyId,
      })

      const nowIso = this.now().toISOString()
      const isNewer = compareVersions(metadata.version, this.installedVersion) > 0
      if (!isNewer) {
        this.currentView = { ...this.currentView, lastCheckedAt: nowIso }
        this.refreshSurface()
        return 'no-update-available'
      }

      const installedDataVersion = readDataVersion(this.config.dataRootDir) ?? 0
      checkMonotonic({
        offeredVersion: metadata.version,
        installedVersion: this.installedVersion,
        offeredDataVersion: metadata.dataVersion,
        installedDataVersion,
      })

      this.verifiedOffer = { manifest, metadata }
      this.currentView = {
        currentVersion: this.installedVersion,
        status: 'update-available',
        available: {
          version: metadata.version,
          notes: metadata.notes,
          migratesData: metadata.dataVersion > installedDataVersion,
        },
        lastCheckedAt: nowIso,
      }
      this.refreshSurface()

      const origin = untrustedOrigin('update-feed')
      this.store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
        type: 'update.available',
        text: `Version ${metadata.version} available`,
        origin,
        payload: {
          version: metadata.version,
          dataVersion: metadata.dataVersion,
          notes: metadata.notes,
          source,
        },
      })
      this.notifications.notify({
        level: 'badge',
        spaceId: SYSTEM_SPACE_ID,
        text: `Version ${metadata.version} available`,
        origin,
      })
      return `update-available:${metadata.version}`
    } catch (error) {
      const reason = messageOf(error)
      // Every failure caught here can embed feed-controlled bytes — a
      // hostile artifact name or trusted comment surfacing inside
      // `verifyReleaseChain`'s message, a zod path/value out of a malformed
      // manifest, and so on (`docs/adr/0013-signed-self-update.md`: ALL
      // feed-derived text stays `untrusted:update-feed`, not only release
      // notes). The Event's own text is a short, fixed, daemon-authored
      // summary; `reason` — the only part that can carry those bytes — goes
      // into the payload instead, and the whole event is still marked
      // untrusted, since a downstream reader trusts by the event's origin,
      // not by which of its fields happens to hold the tainted text.
      const origin = untrustedOrigin('update-feed')
      this.store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
        type: 'update.check',
        text: 'update check failed',
        origin,
        payload: { source, reason },
      })
      const nowIso = this.now().toISOString()
      // Status intentionally stays whatever it already was (idle, or a
      // still-standing earlier offer) — a transient check failure (the feed
      // being briefly unreachable, say) must never overwrite a real offer
      // or fabricate a `refused` outcome that belongs to an apply attempt,
      // not a discovery check. `outcomeDetail` only overwrites when `status`
      // is not itself already a terminal apply outcome (`outcomeTone`,
      // `update-surface.ts`) — otherwise a background check failure would
      // clobber the text under a still-showing `applied`/`rolled-back`/
      // `refused` Badge, contradicting its own tone (issue #43 review
      // follow-up). When it does overwrite, the Surface refresh is forced to
      // the same untrusted origin as the Event, for the same reason: the
      // content now includes feed/error-derived text even though the current
      // rendering never shows it outside a terminal status.
      if (outcomeTone(this.currentView.status) === undefined) {
        this.currentView = { ...this.currentView, outcomeDetail: reason, lastCheckedAt: nowIso }
        this.refreshSurface(origin)
      } else {
        this.currentView = { ...this.currentView, lastCheckedAt: nowIso }
        this.refreshSurface()
      }
      return `check-failed:${reason}`
    }
  }

  /**
   * Re-verifies the offer (never acts on a stale one — the feed, the
   * signing key, or the offer itself may have changed since the last
   * check), then writes the marker the wrapper's transaction consumes on
   * restart, appends the user's own apply event, patches the Surface to
   * `updating`, and exits with the dedicated code
   * (`docs/adr/0013-signed-self-update.md`).
   *
   * Refuses outright — before touching the network or writing anything —
   * while an update transaction is already live on disk: an active journal
   * (`state/update-state.json`) means the wrapper is mid-transaction (the
   * stage-2 window, or a transaction stuck resuming/failing repeatedly), and
   * an unswept `state/result.json` means the previous transaction's outcome
   * has not yet been durably ingested and archived. Writing a second marker
   * on top of either is exactly the wedge `issues/043-self-update.md`'s Goal
   * rules out (issue #43 review follow-up): `update-cli run` would be left
   * juggling two competing pieces of state, forever re-resuming the stale
   * journal while a fresh marker sits unconsumed, with no SSH-free way out.
   */
  async applyUpdate(): Promise<void> {
    if (existsSync(journalFilePath(this.home)) || existsSync(resultFilePath(this.home))) {
      this.currentView = {
        ...this.currentView,
        status: 'refused',
        outcomeDetail: 'an update is already in progress',
      }
      this.refreshSurface()
      return
    }

    await this.runCheck('manual')
    if (!this.verifiedOffer) return
    const { manifest, metadata } = this.verifiedOffer

    const marker: UpdateMarker = UpdateMarkerSchema.parse({
      requestedAt: this.now().toISOString(),
      release: manifest.release,
      releaseSig: manifest.releaseSig,
      signingKey: manifest.signingKey,
      artifactUrl: manifest.artifactUrl,
    })
    writeJsonAtomic(this.home.stateDir, 'marker.json', marker)

    this.store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
      type: 'update.apply',
      text: `Update to ${metadata.version} requested`,
      // The tap itself is a genuine user fast-path action, not something
      // the daemon decided on its own (`docs/SECURITY.md` §3.2's origin
      // discipline: the scheduler's condition rule must never be
      // self-satisfiable by a daemon write, and neither should this).
      origin: 'trusted:user',
    })

    this.currentView = { ...this.currentView, status: 'updating' }
    this.refreshSurface()

    this.config.scheduleExit()
  }

  private resetFastActionKey(key: string): void {
    const existing = this.store.getSurface(UPDATE_SURFACE_ID)
    if (!existing || existing.state[key] === false) return
    const version = this.store.getSurfaceVersion(UPDATE_SURFACE_ID)
    if (!version) return
    this.store.patchState(
      UPDATE_SURFACE_ID,
      [{ target: 'state', op: 'replace', path: `/${key}`, value: false }],
      { updatedBy: 'job', origin: 'trusted:system' },
    )
  }

  private ensureSurface(): void {
    if (!this.store.getSurface(UPDATE_SURFACE_ID)) this.refreshSurface()
  }

  /**
   * Rebuilds the Update Surface's fixed-slot tree from `this.currentView`.
   * `origin`/`contentOrigin` are always passed explicitly — never omitted —
   * so a feed-derived offer's notes can never default to a trusted origin
   * (`update-surface.ts`'s `updateSurfaceContentOrigin`, the same discipline
   * `template-engine.ts`'s `instantiate` and `scheduler.ts`'s
   * `refreshSurface` apply to their own Surface writes). `forcedOrigin`
   * overrides the usual `available`-derived computation for the one caller
   * whose content can carry feed/error-derived text even with no offer on
   * display — a failed check's `outcomeDetail` (`runCheck`'s catch block,
   * `docs/adr/0013-signed-self-update.md`: ALL feed-derived text stays
   * untrusted, not only release notes).
   */
  private refreshSurface(forcedOrigin?: Origin): void {
    const origin = forcedOrigin ?? updateSurfaceContentOrigin(this.currentView.available)
    const existing = this.store.getSurface(UPDATE_SURFACE_ID)

    if (!existing) {
      const freshness = { updatedAt: this.now().toISOString(), updatedBy: 'job' as const }
      this.store.createSurface(updateSurface(this.currentView, freshness), 'job', {
        daemonOwned: true,
        origin,
        contentOrigin: origin,
      })
      return
    }

    const version = this.store.getSurfaceVersion(UPDATE_SURFACE_ID)
    if (!version) return
    const view = this.currentView
    this.store.patchTree(
      UPDATE_SURFACE_ID,
      [
        { target: 'tree', op: 'replace', path: '/children/1', value: currentStatNode(view) },
        { target: 'tree', op: 'replace', path: '/children/2', value: availableSlotNode(view) },
        { target: 'tree', op: 'replace', path: '/children/3', value: outcomeSlotNode(view) },
        { target: 'tree', op: 'replace', path: '/children/4', value: buttonsRowNode(view) },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job', origin },
    )
  }

  // ---------------------------------------------------------------------
  // Boot-time result ingestion (docs/adr/0013-signed-self-update.md R2-4)
  // ---------------------------------------------------------------------

  /**
   * Ingests `state/result.json`, in a strict, crash-safe order (issue #43
   * review follow-up): (1) append the `update.outcome` event exactly once
   * per result id (deduped against the last two days of the System Space's
   * own Event log, the same bounded read `Heartbeat.metrics()` uses) — (2)
   * fsync the day's Event-log file — (3) notify a badge and patch the
   * Surface to the terminal outcome — (4) only then create and fsync the
   * durable ack file. Every step but the last is allowed to fail loudly
   * (logged, never thrown past this method — an unhandled rejection here
   * would be worse than a retried boot): a failure at (1) or (2) leaves no
   * ack behind and `result.json` untouched, so the next boot retries the
   * whole thing from scratch, never telling the wrapper an outcome is
   * durably recorded when it might not be.
   *
   * The dedupe check (the event already exists) skips straight to (3): a
   * deduped result whose ack is missing is exactly the crash case this
   * ordering exists for — the earlier attempt got the event durably
   * appended but died before patching the Surface/notifying or before the
   * ack landed, so this call must still (re-)ensure the Surface/badge state
   * exists before acking. Once the ack itself is already on disk, ingestion
   * is fully done and this returns immediately: `result.json` is never
   * deleted or moved here — the updater/wrapper alone retires it, once this
   * ack is durably in place (`update/update-transaction.ts`'s
   * `sweepAckedResult`).
   */
  private async ingestResult(resultPath: string): Promise<void> {
    let result: UpdateResult
    try {
      result = UpdateResultSchema.parse(JSON.parse(readFileSync(resultPath, 'utf8')))
    } catch (error) {
      console.error('update-manager: result.json is unreadable/invalid', error)
      return
    }

    if (existsSync(ackFilePath(this.home, result.id))) return

    const cutoff = new Date(this.now().getTime() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const alreadyHasEvent = this.store
      .eventLogSince(SYSTEM_SPACE_ID, cutoff)
      .some((event) => event.type === 'update.outcome' && event.payload?.['resultId'] === result.id)

    if (!alreadyHasEvent) {
      let event: SpaceEvent
      try {
        event = this.store.spacesEngine.appendEvent(SYSTEM_SPACE_ID, {
          type: 'update.outcome',
          text: `Update to ${result.toVersion}: ${result.outcome}`,
          origin: 'trusted:system',
          payload: {
            resultId: result.id,
            outcome: result.outcome,
            reason: result.reason,
            ...(result.failedStage === undefined ? {} : { failedStage: result.failedStage }),
          },
        })
      } catch (error) {
        console.error(
          'update-manager: failed to append the update.outcome event; result.json left in place for the next boot to retry',
          error,
        )
        return
      }

      try {
        this.fsyncDayLog(event.at)
      } catch (error) {
        console.error(
          'update-manager: failed to fsync the day log before acking; result.json left in place for the next boot to retry',
          error,
        )
        return
      }
    }

    this.notifications.notify({
      level: 'badge',
      spaceId: SYSTEM_SPACE_ID,
      text: `Update to ${result.toVersion}: ${result.outcome}`,
    })

    this.currentView = {
      currentVersion: this.installedVersion,
      status: outcomeStatus(result.outcome),
      outcomeDetail: outcomeDetail(result),
      lastCheckedAt: this.now().toISOString(),
    }
    this.refreshSurface()

    try {
      this.writeAckFile(result.id)
    } catch (error) {
      console.error(
        'update-manager: failed to write the durable ack file; will retry on the next boot',
        error,
      )
    }
  }

  /** Atomic-create (never overwrites) + fsync file and directory — the durable acknowledgment `sweepAckedResult` waits for before retiring `result.json`. */
  private writeAckFile(id: string): void {
    const path = ackFilePath(this.home, id)
    if (existsSync(path)) return
    mkdirSync(this.home.stateDir, { recursive: true })
    let fd: number
    try {
      fd = openSync(path, 'wx', 0o600)
    } catch (error) {
      // Another ingestion attempt already created it (or a genuine fs
      // error, in which case the next boot's ingestion retries this).
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return
      throw error
    }
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const dirFd = openSync(this.home.stateDir, fsConstants.O_RDONLY)
    try {
      fsyncSync(dirFd)
    } finally {
      closeSync(dirFd)
    }
  }

  /**
   * Fsyncs the System Space's day-log file the outcome event was just
   * appended to: `SpacesEngine.appendEvent` writes with a plain
   * `appendFileSync`, which is not itself durable, and the ack file must
   * never become visible while the event it acknowledges is still only
   * page-cache-resident. Reconstructs the path via the public
   * `spacesEngine.rootDir` + the Space's own `slug` — the same `spaces/
   * <slug>/log/<YYYY-MM-DD>.jsonl` convention `SpacesEngine.logPath`
   * (private) uses internally, documented for external readers by
   * `memory-index.ts`'s `EVENT_REF_RE`.
   *
   * Throws rather than swallowing (issue #43 review follow-up): a missing
   * System Space or a failed fsync both mean the just-appended event's
   * durability cannot be confirmed, and `ingestResult` must treat either the
   * same way — no ack, `result.json` left for the next boot to retry —
   * rather than one path silently proceeding to ack an event that was never
   * actually synced to disk.
   */
  private fsyncDayLog(atIso: string): void {
    const space = this.store.getSpace(SYSTEM_SPACE_ID)
    if (!space) {
      throw new Error(
        'update-manager: System Space not found; cannot fsync the day log before acking',
      )
    }
    const day = atIso.slice(0, 10)
    const path = join(this.store.spacesEngine.rootDir, 'spaces', space.slug, 'log', `${day}.jsonl`)
    const fd = openSync(path, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

function outcomeStatus(outcome: UpdateResult['outcome']): UpdateSurfaceView['status'] {
  if (outcome === 'success') return 'applied'
  if (outcome === 'rolled-back') return 'rolled-back'
  return 'refused'
}

function outcomeDetail(result: UpdateResult): string {
  if (result.outcome === 'success') return `Updated to ${result.toVersion}`
  return result.reason || result.failedStage || result.outcome
}
