import { SurfaceActionError } from './fast-action.ts'
import { automationsSurfaceIdForSpace } from './automations-surface.ts'
import { reflectionSurfaceId } from './reflection-surface.ts'
import {
  SYSTEM_SPACE_ID,
  SurfaceSnapshotSchema,
  findDeclaredAction,
  type ChatTurnCorrelation,
  type ChatMessage,
  type AutomationOutcomeKind,
  type JsonObject,
  type PatchOperation,
  type Space,
  type Surface,
  type SurfaceMoveDirection,
  type SurfacePresentation,
  type SurfaceSnapshot,
  type ActionInvocation,
  AgentActionInvocationSchema,
  type FastActionOutcome,
  type CommittedFastActionOutcome,
} from '@veduta/protocol'
import type { ToolDef } from './agent-runner.ts'
import type { FactsDocument } from './facts.ts'
import { seedSpaces } from './seed.ts'
import type { RelativeTimeAuthoring } from './relative-time-surface.ts'
import type { MemoryBudget } from './memory-config.ts'
import type { Origin } from './taint.ts'
import { SpacesEngine, type FactSearchHit, type SpaceEvent } from './spaces-engine.ts'
import type {
  SurfaceCommitRecord,
  SurfaceCommitRecoveryPendingError,
  SurfaceCommitTransport,
} from './surface-commit.ts'
import {
  SurfaceEngine,
  type AuthorableSurfaceInventory,
  type AuthorableSurfaceRead,
  type CreateSurfaceOptions,
  type QueuedAgentTurn,
  type SurfaceEngineEvent,
  type SurfaceMutation,
  type FastActionPreflightContext,
  type SurfacePinMutation,
  type SurfacePresentationOptions,
  type SurfaceProvenance,
  type SurfaceVersion,
  type TreeProposal,
  type TreeProposalRecorded,
  type TreeProposalStatus,
} from './surface-engine.ts'

export interface StoreOptions {
  rootDir?: string
  now?: () => Date
  /** Global user timezone used by every relative-time Surface projection. */
  timeZone?: string
  /** Rendered active FACTS low/high/hard watermarks. */
  memoryBudget?: MemoryBudget
  surfaceCommitTransport?: (spacesEngine: SpacesEngine) => SurfaceCommitTransport
}

export type SurfaceActionResult =
  { path: 'fast'; outcome: FastActionOutcome } | { path: 'agent'; turn: QueuedAgentTurn }
export { SurfaceActionError } from './fast-action.ts'
export type { SurfaceActionErrorCode } from './fast-action.ts'

/**
 * Store facade for the Gateway: Surfaces stay behind protocol validation,
 * while Space memory is file-backed by SpacesEngine (issue #6).
 *
 * Fast-path contract (ADR-0003): every deterministic mutation appends
 * an event to the Space's Event log so the Agent finds it before
 * reasoning about the Space.
 */
export class Store {
  readonly spacesEngine: SpacesEngine
  private readonly surfaceEngine: SurfaceEngine
  private readonly now: () => Date
  private readonly llmCalls = 0

  constructor(options: StoreOptions = {}) {
    this.now = options.now ?? (() => new Date())
    const timeZone = options.timeZone ?? 'UTC'
    const seed = seedSpaces({ relativeTimeNow: this.now, timeZone })
    this.spacesEngine = new SpacesEngine({
      now: this.now,
      seed: { spaces: seed.spaces, surfaces: [] },
      ...(options.rootDir === undefined ? {} : { rootDir: options.rootDir }),
      ...(options.memoryBudget === undefined ? {} : { memoryBudget: options.memoryBudget }),
    })
    const persistedSurfaces = this.spacesEngine.listPersistedSurfaces()
    this.surfaceEngine = new SurfaceEngine({
      rootDir: this.spacesEngine.rootDir,
      now: this.now,
      timeZone,
      seed:
        persistedSurfaces.length > 0
          ? persistedSurfaces
          : seed.surfaces.filter((surface) => Boolean(this.spacesEngine.getSpace(surface.spaceId))),
      hasSpace: (spaceId) => Boolean(this.spacesEngine.getSpace(spaceId)),
      surfaceCommits: options.surfaceCommitTransport?.(this.spacesEngine) ?? this.spacesEngine,
    })
  }

  recoveryPendingSurfaceCommits(spaceId?: string): SurfaceCommitRecord[] {
    return this.surfaceEngine.recoveryPending(spaceId)
  }

  reconcilePendingSurfaceCommits(): SurfaceCommitRecoveryPendingError[] {
    return this.surfaceEngine.reconcilePendingSurfaceCommits()
  }

  assertSpaceReadyForAgent(spaceId: string): void {
    this.surfaceEngine.assertSpaceReadyForAgent(spaceId)
  }

  listSpaces(): Space[] {
    return this.spacesEngine.listSpaces()
  }

  getSpace(id: string): Space | undefined {
    return this.spacesEngine.getSpace(id)
  }

  listSurfaces(spaceId?: string): Surface[] {
    const stored = this.surfaceEngine
      .listSurfaces(spaceId)
      .map((surface) => this.projectManagementSurface(surface))
    // The generic FACTS projection belongs only to user life-area Spaces (ADR-0020).
    if (spaceId) {
      return spaceId === SYSTEM_SPACE_ID
        ? stored
        : [...stored, this.spacesEngine.factsSurface(spaceId)]
    }
    return [...stored, ...this.listProjectedFactsSurfaces()]
  }

  getSurface(id: string): Surface | undefined {
    const surface =
      this.surfaceEngine.getSurface(id) ??
      this.listProjectedFactsSurfaces().find((surface) => surface.id === id)
    return surface ? this.projectManagementSurface(surface) : undefined
  }

  /** Classification stays in the Gateway; neither user titles nor Agent-supplied metadata grant it. */
  projectManagementSurface(surface: Surface): Surface {
    const { management: _management, ...content } = surface
    const space = this.getSpace(surface.spaceId)
    if (!space) return content
    if (
      !this.surfaceEngine.getSurface(surface.id) &&
      surface.id === `srf-${space.slug}-facts` &&
      space.id !== SYSTEM_SPACE_ID
    )
      return { ...content, management: 'memory' }
    if (!this.surfaceEngine.isDaemonOwned(surface.id)) return content
    if (surface.id === automationsSurfaceIdForSpace(space))
      return { ...content, management: 'automations' }
    if (surface.id === reflectionSurfaceId(space.slug))
      return { ...content, management: 'reflection' }
    return content
  }

  /** Returns only a persisted Surface that can participate in mutation paths. */
  getStoredSurface(id: string): Surface | undefined {
    return this.surfaceEngine.getSurface(id)
  }

  snapshot(): SurfaceSnapshot {
    return SurfaceSnapshotSchema.parse({
      surfaceCursor: this.latestSurfaceCursor(),
      spaces: this.listSpaces().map((space) => ({
        ...space,
        surfaces: this.listSurfaces(space.id),
      })),
    })
  }

  latestSurfaceCursor(): number {
    return this.surfaceEngine.latestSurfaceCursor()
  }

  surfaceEventsAfter(cursor: number): SurfaceEngineEvent[] {
    return this.surfaceEngine.surfaceEventsAfter(cursor)
  }

  /**
   * Observe every committed Surface event exactly once after it commits.
   * The Gateway is the sole subscriber in production: one central
   * broadcast, never a manual one.
   */
  onSurfaceEvent(observer: (event: SurfaceEngineEvent) => void): () => void {
    return this.surfaceEngine.onSurfaceEvent(observer)
  }

  close(): void {
    this.surfaceEngine.close()
  }

  /**
   * Observe every newly recorded Tree proposal exactly once, after it
   * commits. `TreeProposalSurfaceManager` is the sole subscriber in
   * production: one central hook, never a manual broadcast.
   */
  onTreeProposal(
    observer: (proposal: TreeProposal, initiatingTurn?: ChatTurnCorrelation) => void,
  ): () => void {
    return this.surfaceEngine.onTreeProposal(observer)
  }

  invokeSurfaceAction(surfaceId: string, invocation: ActionInvocation): SurfaceActionResult {
    if ('intentId' in invocation)
      return { path: 'fast', outcome: this.surfaceEngine.invokeFastAction(surfaceId, invocation) }
    const parsedInvocation = AgentActionInvocationSchema.parse(invocation)
    const replay = this.surfaceEngine.replayAgentAction(surfaceId, parsedInvocation)
    if (replay) return { path: 'agent', turn: replay }
    const surface = this.getSurface(surfaceId)
    if (!surface) throw new SurfaceActionError('unknown_surface', 'unknown Surface')
    const action = findDeclaredAction(surface.tree, invocation.nodeId, invocation.name)
    if (!action) throw new SurfaceActionError('undeclared_action', 'undeclared Action')
    if (action.path !== 'agent')
      throw new SurfaceActionError(
        'invalid_payload',
        'fast Actions require a revision, stable intent identity, and typed inputs',
      )
    return {
      path: 'agent',
      turn: this.surfaceEngine.enqueueAgentAction(surface, parsedInvocation),
    }
  }
  onFastActionPreflight(preflight: (context: FastActionPreflightContext) => void): () => void {
    return this.surfaceEngine.onFastActionPreflight(preflight)
  }
  onFastActionOutcome(
    name: string,
    observer: (outcome: CommittedFastActionOutcome) => void | Promise<void>,
  ): () => void {
    return this.surfaceEngine.onFastActionOutcome(name, observer)
  }

  createSurface(
    surface: Surface,
    updatedBy: 'agent' | 'user' | 'job',
    options?: CreateSurfaceOptions,
  ): Surface {
    return this.surfaceEngine.createSurface(surface, updatedBy, options)
  }

  patchState(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      updatedBy: 'agent' | 'user' | 'job'
      origin?: Origin
      relativeTime?: RelativeTimeAuthoring
      eventPayload?: JsonObject
    },
  ): SurfaceMutation {
    return this.surfaceEngine.patchState(surfaceId, operations, options)
  }

  commitAutomationOutcome(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      automationId: number
      scheduledFor: string
      kind: AutomationOutcomeKind
      summary: string
      idempotencyKey: string
      expectedVersion?: number
      origin?: Origin
      checkedAt?: string
      historyId?: string
      recordInHistory?: boolean
      notificationIntent?: JsonObject
    },
  ): SurfaceMutation {
    return this.surfaceEngine.commitAutomationOutcome(surfaceId, operations, options)
  }

  validateAutomationOutcomeOperations(surfaceId: string, operations: PatchOperation[]): void {
    this.surfaceEngine.validateAutomationOutcomeOperations(surfaceId, operations)
  }

  patchTree(
    surfaceId: string,
    operations: PatchOperation[],
    options: {
      expectedTreeVersion: number
      updatedBy: 'agent' | 'user' | 'job'
      origin?: Origin
      bypassPin?: true
      initiatingTurn?: ChatTurnCorrelation
      eventPayload?: JsonObject
    },
  ): SurfaceMutation | TreeProposalRecorded {
    return this.surfaceEngine.patchTree(surfaceId, operations, options)
  }

  patchDaemonSurface(
    surfaceId: string,
    operations: PatchOperation[],
    options: { expectedTreeVersion: number; origin?: Origin },
  ): SurfaceMutation {
    return this.surfaceEngine.patchDaemonSurface(surfaceId, operations, options)
  }

  archiveSurface(surfaceId: string, updatedBy: 'agent' | 'user' | 'job'): Surface {
    return this.surfaceEngine.archiveSurface(surfaceId, updatedBy)
  }

  getSurfaceVersion(surfaceId: string): SurfaceVersion | undefined {
    return this.surfaceEngine.getSurfaceVersion(surfaceId)
  }

  setSurfacePresentation(
    surfaceId: string,
    presentation: SurfacePresentation,
    options: SurfacePresentationOptions,
  ) {
    return this.surfaceEngine.setPresentation(surfaceId, presentation, options)
  }

  /** Space-scoped read seam for the Agent's focused-Space Surface registry. */
  listAuthorableSurfaces(spaceId: string): AuthorableSurfaceInventory {
    this.assertSpaceReadyForAgent(spaceId)
    return this.surfaceEngine.listAuthorableSurfaces(spaceId)
  }

  /** Space-scoped read seam for one complete Agent-authorable Surface. */
  readAuthorableSurface(spaceId: string, surfaceId: string): AuthorableSurfaceRead {
    this.assertSpaceReadyForAgent(spaceId)
    return this.surfaceEngine.readAuthorableSurface(spaceId, surfaceId)
  }

  /**
   * Locks or unlocks a Surface's tree; refuses a non-pinnable or unknown
   * Surface. `options.origin`/`options.updatedBy` are the caller's own
   * (never hardcoded here or in `SurfaceEngine.setPinned`) — see that
   * method's docstring for why a hardcoded `trusted:user` would forge a
   * user event.
   */
  setPinned(
    surfaceId: string,
    pinned: boolean,
    options: { origin: Origin; updatedBy: 'user' | 'agent' | 'job' },
  ): Surface {
    return this.surfaceEngine.setPinned(surfaceId, pinned, options).surface
  }

  setPinnedWithOrder(
    surfaceId: string,
    pinned: boolean,
    options: { origin: Origin; updatedBy: 'user' | 'agent' | 'job' },
  ): SurfacePinMutation {
    return this.surfaceEngine.setPinned(surfaceId, pinned, options)
  }

  surfaceOrder(spaceId: string) {
    return this.surfaceEngine.surfaceOrder(spaceId)
  }

  moveSurface(spaceId: string, surfaceId: string, direction: SurfaceMoveDirection) {
    return this.surfaceEngine.moveSurface(spaceId, surfaceId, direction)
  }

  /** Active, non-daemon-owned Surfaces whose tree has not changed since `beforeIso`. */
  stableSurfaces(beforeIso: string): Surface[] {
    return this.surfaceEngine.stableSurfaces(beforeIso)
  }

  /** The stored Template provenance for `surfaceId`, or `undefined` if unknown. */
  surfaceProvenance(surfaceId: string): SurfaceProvenance | undefined {
    return this.surfaceEngine.surfaceProvenance(surfaceId)
  }

  /** Tree proposals `patchTree` recorded, optionally filtered by Surface and/or status. */
  listTreeProposals(options?: { surfaceId?: string; status?: TreeProposalStatus }): TreeProposal[] {
    return this.surfaceEngine.listTreeProposals(options)
  }

  /** The Tree proposal at `id`, or `undefined` if unknown. */
  getTreeProposal(id: number): TreeProposal | undefined {
    return this.surfaceEngine.getTreeProposal(id)
  }

  /** Resolves a `pending` Tree proposal exactly once; see `SurfaceEngine.resolveTreeProposal`. */
  resolveTreeProposal(
    id: number,
    status: 'accepted' | 'rejected' | 'stale',
    actor: 'trusted:user',
  ): TreeProposal | undefined {
    return this.surfaceEngine.resolveTreeProposal(id, status, actor)
  }

  /** Puts an `accepted` Tree proposal back to `pending`; see `SurfaceEngine.reopenTreeProposal`. */
  reopenTreeProposal(id: number): TreeProposal | undefined {
    return this.surfaceEngine.reopenTreeProposal(id)
  }

  /**
   * Whether `surfaceId` was created with `daemonOwned: true` (approval
   * cards, trust admin Surfaces). `false` for an unknown surfaceId. Lets a
   * caller distinguish the daemon's own canonical Surface from an impostor
   * occupying the same (deterministic) id before adopting it — see
   * `ApprovalSurfaceManager.start()`.
   */
  isSurfaceDaemonOwned(surfaceId: string): boolean {
    return this.surfaceEngine.isDaemonOwned(surfaceId)
  }

  adoptCanonicalDaemonSurface(surface: Surface, origin: Origin): Surface {
    return this.surfaceEngine.adoptCanonicalDaemonSurface(surface, origin)
  }

  surfaceTools(): ToolDef[] {
    return this.surfaceEngine.surfaceTools()
  }

  agentTurns(): QueuedAgentTurn[] {
    return this.surfaceEngine.agentTurns()
  }

  agentTurn(id: string): QueuedAgentTurn | undefined {
    return this.surfaceEngine.agentTurn(id)
  }

  queuedAgentTurns(): QueuedAgentTurn[] {
    return this.surfaceEngine.queuedAgentTurns()
  }

  claimAgentTurn(id: string): QueuedAgentTurn | undefined {
    return this.surfaceEngine.claimAgentTurn(id)
  }

  finishAgentTurn(
    id: string,
    result: { message: ChatMessage; surfaceCursor: number } | { error: string },
  ): QueuedAgentTurn | undefined {
    return this.surfaceEngine.finishAgentTurn(id, result)
  }

  interruptAgentTurns(): QueuedAgentTurn[] {
    return this.surfaceEngine.interruptAgentTurns()
  }

  llmCallCount(): number {
    return this.llmCalls
  }

  private listProjectedFactsSurfaces(): Surface[] {
    return this.listSpaces()
      .filter((space) => space.id !== SYSTEM_SPACE_ID)
      .map((space) => this.spacesEngine.factsSurface(space.id))
  }

  eventLog(spaceId: string): SpaceEvent[] {
    return this.spacesEngine.readRecent(spaceId, Number.MAX_SAFE_INTEGER)
  }

  /** Bounded Event log read: only the daily files that can hold `sinceIso` or later. */
  eventLogSince(spaceId: string, sinceIso: string): SpaceEvent[] {
    return this.spacesEngine.readSince(spaceId, sinceIso)
  }

  writeFact(spaceId: string, fact: string) {
    return this.spacesEngine.writeFact(spaceId, fact)
  }

  readFacts(spaceId: string): FactsDocument {
    return this.spacesEngine.readFacts(spaceId)
  }

  searchFacts(spaceId: string, query: string): FactSearchHit[] {
    return this.spacesEngine.searchFacts(spaceId, query)
  }

  archiveSpace(spaceId: string): Space {
    return this.spacesEngine.archiveSpace(spaceId)
  }

  restoreSpace(spaceId: string): Space {
    return this.spacesEngine.restoreSpace(spaceId)
  }

  assembleSpaceContext(spaceId: string): string {
    this.assertSpaceReadyForAgent(spaceId)
    return this.spacesEngine.assembleContext(spaceId)
  }

  assembleSpaceContextWithOrigins(spaceId: string, options?: { includeGlobal?: boolean }) {
    this.assertSpaceReadyForAgent(spaceId)
    return this.spacesEngine.assembleContextWithOrigins(spaceId, undefined, options)
  }

  /** The global identity documents (SOUL/USER), for the global chat's system prompt (issue #37). */
  readGlobalDocs(): { soul: string; user: string } {
    return this.spacesEngine.readGlobalDocs()
  }
}
