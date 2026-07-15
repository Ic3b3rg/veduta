import { randomUUID } from 'node:crypto'
import type { JsonObject, Surface } from '@veduta/protocol'
import type { AgentEvent, AgentRunner, ModelRef, ToolDef, TriggerRef } from './agent-runner.ts'
import { SpendingCapError, type ModelRouter } from './model-routing.ts'
import type { SpaceEvent } from './spaces-engine.ts'
import type { FastMutationNotice, Store } from './store.ts'
import { untrustedOrigin } from './taint.ts'
import {
  buildWorkerPrompt,
  parseWorkerReport,
  WorkerReportSchema,
  WORKER_REPORT_VERSION,
  type WorkerBriefing,
  type WorkerReport,
} from './worker-briefing.ts'
import { reviewReport, type WorkerReviewVerdict } from './worker-review.ts'
import {
  activeWorkerSurface,
  workerReportContentNode,
  workerStatusNode,
  workerSurfaceId,
  workerTerminalFooterNode,
  WORKER_CANCEL_STATE_KEY,
  WORKER_CONTENT_INDEX,
  WORKER_FOOTER_INDEX,
  WORKER_SETTLED_STATE_KEY,
  WORKER_STATUS_INDEX,
} from './worker-surface.ts'

/**
 * The Worker run-state machine (issue #17, plan v2 T4): spawns ephemeral
 * Workers, runs each on its own `AgentRunner` in an isolated session,
 * enforces the briefing's iteration/token budget, runs the adversarial
 * review (worker-review.ts) for high-risk briefings, and delivers exactly
 * one schema-valid `WorkerReport` into the Space — never worker→worker, a
 * Worker only ever reports back to the Space/main loop that spawned it.
 *
 * B4 (lethal trifecta defense, ADR-0007): every tool offered to a Worker
 * must be `L0` with empty `egressDomains` — asserted in the constructor —
 * and the Worker's runner is never given a trust-wrap predicate, so an L1/L2
 * tool can never slip through `gateToolsForOrigins`'s taint gate. A Worker is
 * further scoped to `briefing.allowedTools` (`toolsForBriefing`): the L0
 * registry is a ceiling, not a grant — an empty `allowedTools` offers zero
 * tools, never the whole registry.
 *
 * B2 (budget, fail-closed): the pool counts every `turn-end` event (one real
 * agent turn) regardless of whether the model reported `tokensUsed` — the
 * iteration cap is the hard backstop, the token budget is best-effort on
 * reported usage. B3 (provenance): the delivered report Event is stamped
 * `untrusted:worker`; lifecycle-only events (spawn/cancel) are content-free
 * and `trusted:system`. B6: invalid model text is never delivered — the
 * last schema-valid report, or a deterministic daemon-authored fallback, is
 * delivered instead.
 *
 * Invariant (review-never-fails-open): a delivered **high-risk** report is
 * ALWAYS either `reviewStatus: 'passed'` or carries a non-empty `caveat` —
 * never clean-and-unreviewed — for every termination path: pass,
 * reject-corrected, reject-caveat, review-error, cap-mid-review,
 * cancel-mid-review, and the unexpected-error/spending-cap paths. This is
 * enforced in exactly one place, at the end of `settle()`, so it also covers
 * the no-valid-draft fallback and any `'skipped'` path uniformly.
 *
 * Crash consistency (ADR-0003, issue #17 re-review): the `worker.delivered`
 * Event is the COMMIT POINT for a Worker's delivery, appended BEFORE the
 * Surface is patched — `recoverAtBoot` reconciles from that event on a
 * restart rather than assuming a `state.settled !== true` Surface is always a
 * genuine orphan, so a crash between the event and the Surface patch can
 * never clobber an already-delivered report with "Interrupted".
 */
export const WORKER_ORIGIN = untrustedOrigin('worker')

const GENERIC_CAVEAT = 'This report could not be independently verified.'
const WORKER_SURFACE_PREFIX = 'srf-worker-'
const WORKER_TITLE_PREFIX = 'Worker: '

export interface WorkerPoolOptions {
  store: Store
  router: ModelRouter
  runnerFactory: (sessionId: string) => AgentRunner
  /** No tools by construction (same idiom as the quarantined reader/reviewer): a model and a prompt in, text and cost out. */
  reviewComplete: (model: ModelRef, prompt: string) => Promise<{ text: string; costUsd?: number }>
  /** MUST be L0-only with empty egress (asserted at construction) — Workers never get L1/L2/egress tools. */
  workerTools: ToolDef[]
  now?: () => Date
  /** Shown on the active Surface while the Worker runs. Defaults to 5. */
  etaMinutes?: number
  /** Injectable for deterministic tests; defaults to a random 8-char id. */
  makeWorkerId?: () => string
}

export interface SpawnArgs {
  briefing: WorkerBriefing
  spaceId: string
  goalLabel: string
  trigger?: TriggerRef
}

interface LiveWorker {
  workerId: string
  sessionId: string
  surfaceId: string
  spaceId: string
  goalLabel: string
  briefing: WorkerBriefing
  trigger?: TriggerRef
  runner?: AgentRunner
  unsubscribeRunner?: () => void
  turnCount: number
  tokens: number
  lastValidReport?: WorkerReport
  /** Incremented every time a turn's text parses as a schema-valid report (issue #17 re-review, Fix 3). Lets `reviewAndDeliver` tell "the corrective prompt produced a genuinely new draft" apart from "it produced nothing parseable at all". */
  reportRevision: number
  budgetExceeded: boolean
  cancelled: boolean
  settled: boolean
  resolveSettled: () => void
}

interface SettleOutcome {
  reviewStatus?: 'passed' | 'skipped'
  caveatOverride?: string
  /** Only for the unexpected-error path: overrides the generic fallback body text. */
  fallbackReason?: string
}

/** Single shape for both the "no valid report at all" fallback and the boot-recovery interrupted report — only the text differs. */
function statusReport(goalLabel: string, summary: string, body: string): WorkerReport {
  return {
    version: WORKER_REPORT_VERSION,
    title: goalLabel,
    summary,
    sections: [{ heading: 'Status', body }],
  }
}

function terminalStatusLabel(args: { partial: boolean; cancelled: boolean }): string {
  if (args.cancelled) return 'Cancelled'
  if (args.partial) return 'Partial'
  return 'Delivered'
}

/** Fresh object literal so it is structurally assignable to `JsonObject` (its index signature), mirrors `readerOutputAsJson`. */
function reportAsJson(report: WorkerReport): JsonObject {
  return {
    version: report.version,
    title: report.title,
    summary: report.summary,
    sections: report.sections.map((section): JsonObject => ({
      heading: section.heading,
      body: section.body,
    })),
    ...(report.claims === undefined
      ? {}
      : {
          claims: report.claims.map((claim): JsonObject => ({
            text: claim.text,
            support: claim.support,
          })),
        }),
    ...(report.caveat === undefined ? {} : { caveat: report.caveat }),
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class WorkerPool {
  private readonly store: Store
  private readonly router: ModelRouter
  private readonly runnerFactory: (sessionId: string) => AgentRunner
  private readonly reviewComplete: WorkerPoolOptions['reviewComplete']
  private readonly workerTools: ToolDef[]
  private readonly now: () => Date
  private readonly etaMinutes: number
  private readonly makeWorkerId: () => string
  private readonly disposeFastMutationObserver: () => void
  private readonly liveWorkers = new Map<string, LiveWorker>()
  private readonly settledPromises = new Map<string, Promise<void>>()
  private disposed = false

  constructor(options: WorkerPoolOptions) {
    for (const tool of options.workerTools) {
      if (tool.level !== 'L0' || tool.egressDomains.length > 0) {
        throw new Error('worker tools must be L0 with empty egress')
      }
    }

    this.store = options.store
    this.router = options.router
    this.runnerFactory = options.runnerFactory
    this.reviewComplete = options.reviewComplete
    // Defensive copy: the caller's array must not be mutable out from under
    // this pool after construction (the registry the L0 assertion above
    // just validated is the registry every future Worker is scoped to).
    this.workerTools = [...options.workerTools]
    this.now = options.now ?? (() => new Date())
    this.etaMinutes = options.etaMinutes ?? 5
    this.makeWorkerId = options.makeWorkerId ?? (() => randomUUID().slice(0, 8))
    this.disposeFastMutationObserver = this.store.onFastMutation((notice) =>
      this.onFastMutation(notice),
    )
  }

  /**
   * Persists the active Surface, appends a content-free lifecycle event, and
   * fires off the run asynchronously. Never awaits the run: chat stays
   * responsive immediately after `spawn` returns.
   */
  spawn(args: SpawnArgs): { workerId: string } {
    const workerId = this.makeWorkerId()
    const sessionId = `worker-${workerId}`
    const surfaceId = workerSurfaceId(workerId)
    const at = this.nowIso()

    this.store.createSurface(
      activeWorkerSurface({
        workerId,
        spaceId: args.spaceId,
        goalLabel: args.goalLabel,
        etaMinutes: this.etaMinutes,
        updatedAt: at,
      }),
      'job',
      { daemonOwned: true },
    )

    this.store.spacesEngine.appendEvent(args.spaceId, {
      type: 'worker.spawned',
      text: 'Worker spawned',
      origin: 'trusted:system',
      payload: { workerId },
      at,
    })

    let resolveSettled: () => void = () => {}
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve
    })
    this.settledPromises.set(workerId, settledPromise)

    const live: LiveWorker = {
      workerId,
      sessionId,
      surfaceId,
      spaceId: args.spaceId,
      goalLabel: args.goalLabel,
      briefing: args.briefing,
      ...(args.trigger === undefined ? {} : { trigger: args.trigger }),
      turnCount: 0,
      tokens: 0,
      reportRevision: 0,
      budgetExceeded: false,
      cancelled: false,
      settled: false,
      resolveSettled,
    }
    this.liveWorkers.set(workerId, live)

    // A thrown run must never become an unhandled rejection: it settles
    // with a fallback report instead. A high-risk report that DID make it
    // to `lastValidReport` before the crash must still never deliver clean
    // (review-never-fails-open) — `settle()`'s own enforcement point covers
    // that uniformly, there was no chance to review it here.
    void this.run(live, args).catch((error: unknown) => {
      this.settle(live, { fallbackReason: `Worker run failed: ${errorText(error)}` })
    })

    return { workerId }
  }

  /**
   * Every persisted `srf-worker-*` Surface at construction/boot time that is
   * already marked `state.settled === true` is left completely untouched:
   * re-patching it would clobber the real report and append a duplicate
   * `worker.delivered` event on every restart (fast path, no Event log scan).
   *
   * Otherwise the Surface is unfinished, but that is NOT the same as "no
   * worker.delivered event exists" — a crash can land between the event
   * (the commit point, appended first in `settle()`) and the Surface patch
   * that follows it. So every other `srf-worker-*` Surface is looked up
   * against `deliveredEventFor`:
   *   - an event EXISTS: the worker DID settle before the crash — reconcile
   *     the Surface/state from that event (`reconcileFromDeliveredEvent`),
   *     appending NO new event (it is already in the log).
   *   - no event: a genuine orphan — recover it as interrupted
   *     (`recoverOrphan`), same as before.
   */
  recoverAtBoot(): void {
    for (const surface of this.store.listSurfaces()) {
      if (!surface.id.startsWith(WORKER_SURFACE_PREFIX)) continue
      if (surface.state[WORKER_SETTLED_STATE_KEY] === true) continue

      const workerId = surface.id.slice(WORKER_SURFACE_PREFIX.length)
      const delivered = this.deliveredEventFor(surface.spaceId, workerId)
      if (delivered) {
        this.reconcileFromDeliveredEvent(surface, delivered)
      } else {
        this.recoverOrphan(surface)
      }
    }
  }

  /**
   * Unsubscribes the fast-mutation observer and aborts every live runner.
   * The process is going down: no further delivery is allowed, even for a
   * prompt/review that resolves after this call returns — `settled` is
   * marked on every live worker up front (so `settle()`'s own guard also
   * blocks it) and `this.disposed` short-circuits `settle()` unconditionally.
   */
  dispose(): void {
    this.disposed = true
    this.disposeFastMutationObserver()
    for (const live of this.liveWorkers.values()) {
      live.settled = true
      try {
        void live.runner?.abort()
      } catch {
        // Best-effort: the process is shutting down regardless.
      }
    }
  }

  /** Test support: resolves once `workerId` has settled. Resolves immediately for an unknown id. */
  whenSettled(workerId: string): Promise<void> {
    return this.settledPromises.get(workerId) ?? Promise.resolve()
  }

  private async run(live: LiveWorker, args: SpawnArgs): Promise<void> {
    const runner = this.runnerFactory(live.sessionId)
    live.runner = runner
    live.unsubscribeRunner = runner.on((event) => this.onAgentEvent(live, event))
    await runner.start(live.sessionId)

    try {
      await this.investigate(live, runner, args)
    } catch (error) {
      if (!(error instanceof SpendingCapError)) throw error
      live.budgetExceeded = true
      // The spending cap tripped inside `router.execute` itself: there is no
      // budget left to even attempt a review. A high-risk report that
      // reached `lastValidReport` must still never deliver clean —
      // `settle()`'s own enforcement point covers that uniformly.
      this.settle(live, { reviewStatus: 'skipped' })
    }
  }

  private async investigate(live: LiveWorker, runner: AgentRunner, args: SpawnArgs): Promise<void> {
    const briefing = live.briefing

    await this.promptWorker(live, runner, args, buildWorkerPrompt(briefing))

    if (briefing.highRisk && live.lastValidReport) {
      // ALWAYS attempt the adversarial review for a high-risk report before
      // delivering — even when the cap was just crossed or a cancel arrived
      // on this very turn (`reviewAndDeliver` derives cancelled/budgetExceeded
      // from `live` itself, and never delivers clean without either a
      // passed review or a caveat).
      await this.reviewAndDeliver(live, runner, args)
      return
    }

    this.settle(live, { reviewStatus: 'skipped' })
  }

  private async reviewAndDeliver(
    live: LiveWorker,
    runner: AgentRunner,
    args: SpawnArgs,
  ): Promise<void> {
    const briefing = live.briefing
    const report = live.lastValidReport
    if (!report) {
      this.settle(live, { reviewStatus: 'skipped' })
      return
    }

    const verdict = await this.safeReview(live, report, briefing)

    if (verdict.verdict === 'pass') {
      this.settle(live, { reviewStatus: 'passed' })
      return
    }

    const hasBudget =
      live.turnCount < briefing.maxIterations &&
      live.tokens < briefing.tokenBudget &&
      !live.cancelled
    if (!hasBudget) {
      this.settleRejected(live, verdict)
      return
    }

    // Captured BEFORE the corrective prompt so it can be compared against
    // afterward (issue #17 re-review, Fix 3): re-reviewing is only ever
    // meaningful when the corrective turn actually produced a NEW
    // schema-valid draft, never when it re-parses to nothing and
    // `lastValidReport` is left exactly as it was before this call.
    const revisionBeforeCorrection = live.reportRevision

    await this.promptWorker(
      live,
      runner,
      args,
      buildWorkerPrompt(briefing, {
        reviewFeedback: { unsupportedClaims: verdict.unsupportedClaims },
      }),
    )

    if (live.cancelled || live.budgetExceeded) {
      // Budget ran out (or a cancel arrived) mid-correction: no second
      // verdict was ever produced, so the FIRST verdict's caveat is the
      // best available signal — never deliver caveat-free just because the
      // corrective attempt itself was the one that hit the cap.
      this.settleRejected(live, verdict)
      return
    }

    if (live.reportRevision === revisionBeforeCorrection) {
      // The corrective prompt produced NO new valid draft (unparseable
      // output, or no turn-end at all): `live.lastValidReport` is still the
      // SAME report the first verdict already rejected. Re-reviewing it
      // would just be re-rolling a verdict on unchanged content, and could
      // deliver the rejected report as "passed" purely by review-call luck.
      // Settle on the FIRST verdict instead — never give a stale draft a
      // second chance to pass.
      this.settleRejected(live, verdict)
      return
    }

    const correctedReport = live.lastValidReport ?? report
    const secondVerdict = await this.safeReview(live, correctedReport, briefing)

    if (secondVerdict.verdict === 'pass') {
      this.settle(live, { reviewStatus: 'passed' })
      return
    }

    this.settleRejected(live, secondVerdict)
  }

  /** Shared terminal shape for every "review did not pass" path in `reviewAndDeliver`: skip the review status and carry the verdict's own caveat forward (falling back to the generic one). */
  private settleRejected(live: LiveWorker, verdict: WorkerReviewVerdict): void {
    this.settle(live, {
      reviewStatus: 'skipped',
      caveatOverride: verdict.suggestedCaveat ?? GENERIC_CAVEAT,
    })
  }

  /**
   * Wraps `reviewReport` so that ANY throw (a transport/provider failure,
   * distinct from `reviewReport`'s own internal fail-safe for an unparseable
   * verdict) is treated exactly like a `reject` verdict with a generic
   * caveat. Fixes review-fails-open: a high-risk report must never be
   * delivered as reviewed/clean on the strength of a review call that never
   * actually completed.
   */
  private async safeReview(
    live: LiveWorker,
    report: WorkerReport,
    briefing: WorkerBriefing,
  ): Promise<WorkerReviewVerdict> {
    try {
      return await reviewReport(report, briefing, {
        router: this.router,
        complete: this.reviewComplete,
        workerId: live.workerId,
        now: this.now,
      })
    } catch {
      return { verdict: 'reject', unsupportedClaims: [], suggestedCaveat: GENERIC_CAVEAT }
    }
  }

  /**
   * The one `router.execute` → `runner.prompt` shape shared by the initial
   * investigation prompt and the post-rejection corrective prompt: resolves
   * the model via the router, offers exactly the tools `briefing.allowedTools`
   * permits (`toolsForBriefing`), and threads the origin/trigger the same way
   * both call sites used to duplicate.
   */
  private async promptWorker(
    live: LiveWorker,
    runner: AgentRunner,
    args: SpawnArgs,
    promptText: string,
  ): Promise<void> {
    await this.router.execute(
      {
        purpose: 'worker',
        origin: 'proactive',
        workerId: live.workerId,
        workerTier: live.briefing.tier,
      },
      (model, attempt) =>
        runner.prompt(promptText, {
          model,
          tools: this.toolsForBriefing(live.briefing),
          origin: WORKER_ORIGIN,
          spaceId: args.spaceId,
          retryOfFailedTurn: attempt > 0,
          ...(args.trigger ? { trigger: args.trigger } : {}),
        }),
    )
  }

  /**
   * The registry (`this.workerTools`, L0-only by construction) is a
   * ceiling, not a grant: a Worker only ever sees the subset of it whose
   * name is listed in its own briefing's `allowedTools` — an empty
   * `allowedTools` means zero tools, never "the whole registry". This is
   * what actually enforces `briefing.allowedTools`; the L0 assertion alone
   * only bounds what COULD be offered, not what a given briefing offers.
   */
  private toolsForBriefing(briefing: WorkerBriefing): ToolDef[] {
    if (briefing.allowedTools.length === 0) return []
    const allowed = new Set(briefing.allowedTools)
    return this.workerTools.filter((tool) => allowed.has(tool.name))
  }

  /**
   * Counts every `turn-end` (one real agent turn), accumulates
   * tokens/cost, keeps the last schema-valid report, and — fail-closed —
   * aborts the runner the instant the iteration cap or token budget is
   * crossed, regardless of whether this particular turn reported usage.
   */
  private onAgentEvent(live: LiveWorker, event: AgentEvent): void {
    if (event.type !== 'turn-end') return

    live.turnCount += 1
    live.tokens += event.tokensUsed ?? 0
    if (event.costUsd !== undefined) {
      this.router.recordSpend(event.model, event.costUsd, { workerId: live.workerId })
    }

    const parsed = parseWorkerReport(event.text)
    if (parsed.ok) {
      live.lastValidReport = parsed.report
      live.reportRevision += 1
    }

    // Token accounting is best-effort per-turn (a model can under/over-report
    // `tokensUsed`, or omit it): the iteration cap below is the hard,
    // fail-closed backstop regardless of what any turn reported.
    if (live.turnCount >= live.briefing.maxIterations || live.tokens >= live.briefing.tokenBudget) {
      live.budgetExceeded = true
      try {
        void live.runner?.abort()
      } catch {
        // Best-effort: the terminal guard below still converges.
      }
    }
  }

  /** Mirrors `scheduler.syncToggleFromSurface`: react to the Worker's own Cancel fast action. */
  private onFastMutation(notice: FastMutationNotice): void {
    if (notice.stateKey !== WORKER_CANCEL_STATE_KEY || notice.value !== true) return
    const live = [...this.liveWorkers.values()].find(
      (worker) => worker.surfaceId === notice.surfaceId,
    )
    if (!live || live.settled) return

    live.cancelled = true
    try {
      void live.runner?.abort()
    } catch {
      // Best-effort: the terminal guard below still converges.
    }

    this.store.spacesEngine.appendEvent(live.spaceId, {
      type: 'worker.cancelled',
      text: 'Worker cancelled',
      origin: 'trusted:system',
      payload: { workerId: live.workerId },
      at: this.nowIso(),
    })
  }

  /**
   * Single terminal guard (B-major): idempotent, so abort/late turn-end/cap/
   * dispose all converge to exactly one delivery. Never delivers invalid
   * model text (B6) — the last valid report, or a deterministic
   * daemon-authored fallback, always wins. No-ops once `dispose()` has run
   * (shutdown must never deliver) or once already settled.
   *
   * Crash consistency (issue #17 re-review, Fix 1): the `worker.delivered`
   * Event is appended BEFORE the Surface is patched/marked settled — it is
   * the COMMIT POINT `recoverAtBoot` reconciles from on a restart. A crash
   * between the two now always resolves to "delivered" (reconciled from the
   * event), never to a clobbered "Interrupted", and the event itself is
   * never silently lost.
   *
   * High-risk invariant (issue #17 re-review, Fix 2): enforced in this one
   * place, after any `caveatOverride` has already been applied — a
   * high-risk report that is not `reviewStatus: 'passed'` and still carries
   * no caveat (e.g. the no-valid-draft fallback, or any future `'skipped'`
   * path that forgets to set one) gets the generic caveat here, so the
   * review-never-fails-open invariant holds on every path without every
   * call site having to remember it individually.
   */
  private settle(live: LiveWorker, outcome: SettleOutcome): void {
    if (this.disposed || live.settled) return
    live.settled = true

    live.unsubscribeRunner?.()
    try {
      void live.runner?.abort()
    } catch {
      // Best-effort: settlement proceeds regardless.
    }

    const cancelled = live.cancelled
    const budgetExceeded = live.budgetExceeded
    const usedFallback = live.lastValidReport === undefined
    const baseReport =
      live.lastValidReport ??
      statusReport(
        live.goalLabel,
        'No valid report was produced.',
        outcome.fallbackReason ?? this.defaultFallbackReason(cancelled, budgetExceeded),
      )
    let report: WorkerReport =
      outcome.caveatOverride !== undefined
        ? { ...baseReport, caveat: outcome.caveatOverride }
        : baseReport

    if (
      live.briefing.highRisk &&
      outcome.reviewStatus !== 'passed' &&
      report.caveat === undefined
    ) {
      report = { ...report, caveat: GENERIC_CAVEAT }
    }

    const partial = budgetExceeded || usedFallback

    this.store.spacesEngine.appendEvent(live.spaceId, {
      type: 'worker.delivered',
      text: 'Worker delivered a report',
      origin: WORKER_ORIGIN,
      payload: {
        workerId: live.workerId,
        partial,
        cancelled,
        ...(outcome.reviewStatus === undefined ? {} : { reviewStatus: outcome.reviewStatus }),
        report: reportAsJson(report),
      },
      at: this.nowIso(),
    })

    const patched = this.projectTerminalSurface(live.surfaceId, report, {
      partial,
      cancelled,
      ...(outcome.reviewStatus === undefined ? {} : { reviewStatus: outcome.reviewStatus }),
    })
    if (patched) this.markSettled(live.surfaceId)

    this.liveWorkers.delete(live.workerId)
    this.settledPromises.delete(live.workerId)
    live.resolveSettled()
  }

  private defaultFallbackReason(cancelled: boolean, budgetExceeded: boolean): string {
    if (cancelled) return 'The worker was cancelled before producing a valid report.'
    if (budgetExceeded) {
      return 'The worker reached its iteration or token budget before producing a valid report.'
    }
    return 'The worker did not produce a valid report.'
  }

  /** Patches the 3 fixed child indices in place, mirroring `heartbeat-surface.ts`'s `refreshSurface`. Returns whether the Surface still existed to patch. */
  private projectTerminalSurface(
    surfaceId: string,
    report: WorkerReport,
    flags: { partial: boolean; cancelled: boolean; reviewStatus?: 'passed' | 'skipped' },
  ): boolean {
    const version = this.store.getSurfaceVersion(surfaceId)
    if (!version) return false

    this.store.patchTree(
      surfaceId,
      [
        {
          target: 'tree',
          op: 'replace',
          path: `/children/${WORKER_STATUS_INDEX}`,
          value: workerStatusNode(terminalStatusLabel(flags)),
        },
        {
          target: 'tree',
          op: 'replace',
          path: `/children/${WORKER_CONTENT_INDEX}`,
          value: workerReportContentNode(report),
        },
        {
          target: 'tree',
          op: 'replace',
          path: `/children/${WORKER_FOOTER_INDEX}`,
          value: workerTerminalFooterNode({
            partial: flags.partial,
            cancelled: flags.cancelled,
            ...(report.caveat === undefined ? {} : { caveat: report.caveat }),
            ...(flags.reviewStatus === undefined ? {} : { reviewStatus: flags.reviewStatus }),
          }),
        },
      ],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job' },
    )
    return true
  }

  /** Marks a Worker Surface's `state.settled` so `recoverAtBoot` never re-patches it on a later restart. */
  private markSettled(surfaceId: string): void {
    this.store.patchState(
      surfaceId,
      [{ target: 'state', op: 'replace', path: `/${WORKER_SETTLED_STATE_KEY}`, value: true }],
      { updatedBy: 'job' },
    )
  }

  /** `srf-worker-*` title is always `Worker: <goalLabel>` (`workerTitle` in worker-surface.ts) — recovers the label back out of it. */
  private goalLabelFor(surface: Surface): string {
    return surface.title.startsWith(WORKER_TITLE_PREFIX)
      ? surface.title.slice(WORKER_TITLE_PREFIX.length)
      : surface.title
  }

  /**
   * Scans the Space's Event log for a previously-appended `worker.delivered`
   * event for `workerId` (mirrors `quarantined-reader.alreadyHandled`'s
   * "idempotency via the Event log" idiom). This is the crash-consistency
   * commit point `recoverAtBoot` (Fix 1, issue #17 re-review) reconciles
   * boot recovery from, rather than treating every unsettled Surface as a
   * genuine orphan.
   */
  private deliveredEventFor(spaceId: string, workerId: string): SpaceEvent | undefined {
    return this.store
      .eventLog(spaceId)
      .find(
        (event) => event.type === 'worker.delivered' && event.payload?.['workerId'] === workerId,
      )
  }

  /**
   * A crash left the Surface/state unfinished AFTER the commit-point event
   * was already appended: the Worker DID settle. Rebuilds the terminal
   * Surface from the event's own payload — never re-derives it from
   * scratch, and never appends a second `worker.delivered` event (the one
   * already in the log IS the delivery). Falls back to a conservative
   * daemon-authored report only if the persisted payload itself somehow
   * fails to validate (defensive; it was produced by this same code).
   */
  private reconcileFromDeliveredEvent(surface: Surface, delivered: SpaceEvent): void {
    const payload = delivered.payload ?? {}
    const parsedReport = WorkerReportSchema.safeParse(payload['report'])
    const report: WorkerReport = parsedReport.success
      ? parsedReport.data
      : statusReport(
          this.goalLabelFor(surface),
          'Delivered before a restart; the delivered report could not be re-read.',
          'The daemon restarted after this Worker delivered its report, but the persisted report failed to validate.',
        )

    const partial = payload['partial'] === true
    const cancelled = payload['cancelled'] === true
    const reviewStatusRaw = payload['reviewStatus']
    const reviewStatus =
      reviewStatusRaw === 'passed' || reviewStatusRaw === 'skipped' ? reviewStatusRaw : undefined

    const patched = this.projectTerminalSurface(surface.id, report, {
      partial,
      cancelled,
      ...(reviewStatus === undefined ? {} : { reviewStatus }),
    })
    if (patched) this.markSettled(surface.id)
  }

  private recoverOrphan(surface: Surface): void {
    const workerId = surface.id.slice(WORKER_SURFACE_PREFIX.length)
    const goalLabel = this.goalLabelFor(surface)
    const report: WorkerReport = {
      ...statusReport(
        goalLabel,
        'Interrupted by a restart before delivery.',
        'The daemon restarted while this Worker was still running.',
      ),
      // Never independently reviewed — the briefing that would drive a real
      // review isn't persisted here, so this is caveated unconditionally
      // regardless of whether the original briefing was high-risk.
      caveat: 'Interrupted before delivery; not independently reviewed.',
    }

    // Event-first commit order, mirroring `settle()`: the `worker.delivered`
    // event is the durable record, so a crash mid-recovery can never lose it
    // (a later boot re-runs recovery and, finding the event, reconciles the
    // Surface from it instead of clobbering).
    this.store.spacesEngine.appendEvent(surface.spaceId, {
      type: 'worker.delivered',
      text: 'Worker delivered a report',
      origin: WORKER_ORIGIN,
      payload: {
        workerId,
        partial: true,
        cancelled: false,
        reviewStatus: 'skipped',
        interrupted: true,
        report: reportAsJson(report),
      },
      at: this.nowIso(),
    })

    const patched = this.projectTerminalSurface(surface.id, report, {
      partial: true,
      cancelled: false,
      reviewStatus: 'skipped',
    })
    if (patched) this.markSettled(surface.id)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }
}
