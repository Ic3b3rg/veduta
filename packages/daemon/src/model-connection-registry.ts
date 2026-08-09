import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  ByokProviderSchema,
  type ConnectionLifecycleState,
  type CreateModelConnectionRequest,
  type AuthorizeModelConnectionRequest,
  type DeviceChallenge,
  type ModelCatalogEntry,
  type ModelConnection,
  type ModelConnectionMethod,
  type ModelConnectionMethodId,
  type ModelConnectionSelection,
  type ModelConnectionsSnapshot,
  type UpdateModelConnectionRequest,
} from '@veduta/protocol'
import {
  ConnectionsFileSchema,
  assertSafeConnectionId,
  loadConnectionsConfig,
  saveConnectionsConfig,
  type ConnectionsFile,
  type ModelConnectionRecord,
} from './connections-config.ts'
import {
  ModelConnectionError,
  connectionErrorFrom,
  type AdapterContext,
  type AdapterEnv,
  type AdapterAvailability,
  type ModelConnectionAdapter,
  type RefreshResult,
} from './model-connection-adapter.ts'
import { loadRoutingConfig, type SecretResolver } from './model-routing.ts'
import type { ModelConnectionRuntime } from './pi-provider-bridge.ts'
import type { SecretsVault } from './secrets-vault.ts'

/** The interrupted-authorization reason every persisted in-flight state is normalized to on boot (issue #47, ADR-0014 amendment). */
const INTERRUPTED_AUTHORIZATION_REASON =
  'authorization was interrupted by a daemon restart; start it again'

const IN_FLIGHT_STATES: readonly ConnectionLifecycleState[] = [
  'authorizing',
  'waiting-for-user',
  'verifying',
  'reconnecting',
]

const REFRESHABLE_STATES: readonly ConnectionLifecycleState[] = [
  'waiting-for-user',
  'connected',
  'expired',
  'reconnecting',
]

const ENSURE_FRESH_WINDOW_MS = 5 * 60_000

/**
 * The exact message `findRecord` throws for an id with no matching record
 * (issue #47). Exported so `model-connection-routes.ts` can tell "the target
 * connection does not exist" (→ HTTP 404) apart from every other `'rejected'`
 * `ModelConnectionError` (→ HTTP 400) without duplicating the string in two
 * files.
 */
export const CONNECTION_NOT_FOUND_MESSAGE = 'no such Model connection'

export interface ModelConnectionRegistryOptions {
  rootDir: string
  adapters: readonly ModelConnectionAdapter[]
  vault: SecretsVault | undefined
  secrets: SecretResolver
  profile: 'loopback' | 'local-vps' | 'vps'
  fetchImpl: typeof fetch
  now: () => Date
  /** One real inference call through the production path, addressed by connection id (server.ts's throwaway probe bridge, used by the verify-then-commit selection flow). */
  probe: (connectionId: string, modelId: string) => Promise<void>
  /** Injected so the registry never has to import `pi-provider-bridge.ts` to know what this build can route to (M5). */
  isRoutableModel: (provider: string, modelId: string) => boolean
  /** Fired after every mutation that persists `connections.json`, so `server.ts` can rebuild and swap the live routing config with no restart. */
  onRoutingChanged?: (file: ConnectionsFile) => void
  env: NodeJS.ProcessEnv
}

/** The result of `applySelectionPrepared`'s step 1 (R3): the WOULD-BE file, never written yet, plus the generation it was computed against. */
export interface PreparedSelection {
  candidateFile: ConnectionsFile
  generation: number
}

/**
 * Drops `stateReason` from `record` and applies `patch` — every lifecycle
 * transition needs both, since a stale reason from a previous `failed` state
 * must never survive onto a freshly `connected` or `authorizing` record, and
 * `exactOptionalPropertyTypes` forbids writing `stateReason: undefined`
 * directly (issue #47, matching `sanitizeErrorText`'s spread-to-omit
 * convention already used across the daemon).
 */
function withState(
  record: ModelConnectionRecord,
  patch: Partial<Omit<ModelConnectionRecord, 'id' | 'method' | 'provider' | 'createdAt'>> & {
    state: ConnectionLifecycleState
    stateAt: string
  },
): ModelConnectionRecord {
  const { stateReason: _droppedReason, ...rest } = record
  return { ...rest, ...patch }
}

/**
 * `ModelConnectionRegistry` owns `connections.json`, the in-memory device
 * challenge map, the per-process availability cache, and every routing
 * rebuild that follows a state change (issue #47, `docs/adr/0014-…`
 * amendment). It is the ONLY caller of `ModelConnectionAdapter` — BYOK, the
 * Claude gate, and (in a later slice) Codex all speak through the same
 * narrow contract (`model-connection-adapter.ts`).
 *
 * Two concurrency primitives make every method safe to call from more than
 * one in-flight request:
 * - `queue()` is a promise-chain mutation queue: every load-modify-save runs
 *   through it, one at a time, so two concurrent writers can never race each
 *   other's read of `connections.json`.
 * - `refreshInternal()` is a per-connection singleflight, checked and
 *   populated BEFORE the first `await`, so two callers arriving in the same
 *   tick share one adapter call rather than issuing two.
 *
 * `generation` is bumped exactly once per persisted write (`persist()`) —
 * the round-2 R3 ruling's compare-and-swap counter that lets
 * `applySelectionPrepared`/`commitSelection` detect a connection change that
 * happened while a model-selection probe was running outside the queue.
 */
export class ModelConnectionRegistry {
  private readonly rootDir: string
  private readonly adapters: readonly ModelConnectionAdapter[]
  private readonly vault: SecretsVault | undefined
  private readonly secrets: SecretResolver
  private readonly profile: 'loopback' | 'local-vps' | 'vps'
  private readonly fetchImpl: typeof fetch
  private readonly now: () => Date
  private readonly probeFn: (connectionId: string, modelId: string) => Promise<void>
  private readonly isRoutableModel: (provider: string, modelId: string) => boolean
  private readonly onRoutingChanged: ((file: ConnectionsFile) => void) | undefined
  private readonly env: NodeJS.ProcessEnv

  private tail: Promise<unknown> = Promise.resolve()
  private generation = 0
  private readonly inflightRefresh = new Map<string, Promise<RefreshResult>>()
  private readonly challenges = new Map<string, DeviceChallenge>()
  private readonly availabilityCache = new Map<ModelConnectionMethodId, AdapterAvailability>()

  constructor(options: ModelConnectionRegistryOptions) {
    this.rootDir = options.rootDir
    this.adapters = options.adapters
    this.vault = options.vault
    this.secrets = options.secrets
    this.profile = options.profile
    this.fetchImpl = options.fetchImpl
    this.now = options.now
    this.probeFn = options.probe
    this.isRoutableModel = options.isRoutableModel
    this.onRoutingChanged = options.onRoutingChanged
    this.env = options.env
  }

  /** The R3 compare-and-swap counter, read by the route layer before starting a selection probe outside the queue. */
  currentGeneration(): number {
    return this.generation
  }

  // ---------------------------------------------------------------------
  // Mutation queue
  // ---------------------------------------------------------------------

  private queue<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(fn)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /** Every persisted write goes through here: validate, back up, write, bump the generation, rebuild routing. */
  private persist(file: ConnectionsFile): void {
    saveConnectionsConfig(this.rootDir, file)
    this.generation++
    this.onRoutingChanged?.(file)
  }

  // ---------------------------------------------------------------------
  // Lookups
  // ---------------------------------------------------------------------

  private findAdapter(methodId: ModelConnectionMethodId): ModelConnectionAdapter {
    const adapter = this.adapters.find((candidate) => candidate.methodId === methodId)
    if (!adapter) {
      throw new ModelConnectionError('internal', `no adapter registered for method "${methodId}"`)
    }
    return adapter
  }

  private findRecord(file: ConnectionsFile, id: string): ModelConnectionRecord {
    const record = file.connections.find((candidate) => candidate.id === id)
    if (!record) throw new ModelConnectionError('rejected', CONNECTION_NOT_FOUND_MESSAGE)
    return record
  }

  private replaceRecord(file: ConnectionsFile, record: ModelConnectionRecord): ConnectionsFile {
    return {
      ...file,
      connections: file.connections.map((candidate) =>
        candidate.id === record.id ? record : candidate,
      ),
    }
  }

  private contextFor(connectionId: string, secretRef: string | undefined): AdapterContext {
    assertSafeConnectionId(connectionId)
    return {
      connectionId,
      rootDir: this.rootDir,
      vault: this.vault,
      secrets: this.secrets,
      fetchImpl: this.fetchImpl,
      now: this.now,
      probe: (modelId: string) => this.probeFn(connectionId, modelId),
      codexHome: join(this.rootDir, 'codex', connectionId),
      ...(secretRef === undefined ? {} : { secretRef }),
    }
  }

  private adapterEnv(): AdapterEnv {
    return { rootDir: this.rootDir, env: this.env, vaultAvailable: this.vault !== undefined }
  }

  private async getAvailability(adapter: ModelConnectionAdapter): Promise<AdapterAvailability> {
    const cached = this.availabilityCache.get(adapter.methodId)
    if (cached) return cached
    const availability = await adapter.availability(this.adapterEnv())
    this.availabilityCache.set(adapter.methodId, availability)
    return availability
  }

  /** `isRoutableModel` never applies to a non-api-key method (device-code/none): a subscription connection's catalog is always routable (M5). */
  private applyRoutable(
    adapter: ModelConnectionAdapter,
    entries: ModelCatalogEntry[],
  ): ModelCatalogEntry[] {
    const alwaysRoutable = adapter.capabilities.authorization !== 'api-key'
    return entries.map((entry) => ({
      ...entry,
      routable: alwaysRoutable || this.isRoutableModel(adapter.providerName, entry.id),
    }))
  }

  /** The wire shape for one record: strips `secretRef`/`lastRefreshAt` (registry-internal, never sent to the PWA), recomputes `catalog[].routable`, and attaches the in-memory device challenge (never persisted). */
  private connectionWire(record: ModelConnectionRecord): ModelConnection {
    const adapter = this.findAdapter(record.method)
    const { secretRef: _droppedSecretRef, lastRefreshAt: _droppedLastRefreshAt, ...wire } = record
    const challenge = this.challenges.get(record.id)
    return {
      ...wire,
      ...(record.catalog ? { catalog: this.applyRoutable(adapter, record.catalog) } : {}),
      ...(challenge ? { challenge } : {}),
    }
  }

  private async buildSnapshot(file: ConnectionsFile): Promise<ModelConnectionsSnapshot> {
    const methods: ModelConnectionMethod[] = []
    for (const adapter of this.adapters) {
      const availability = await this.getAvailability(adapter)
      methods.push({
        id: adapter.methodId,
        provider: adapter.providerName,
        providerDisplayName: adapter.providerDisplayName,
        methodDisplayName: adapter.methodDisplayName,
        capabilities: adapter.capabilities,
        available: availability.available,
        ...(availability.available
          ? {}
          : {
              unavailableReason: availability.reason,
              ...(availability.docsUrl === undefined ? {} : { docsUrl: availability.docsUrl }),
            }),
      })
    }

    const connections = file.connections.map((record) => this.connectionWire(record))
    const selection = file.selection ?? this.deriveDisplaySelection(file)

    return {
      vaultAvailable: this.vault !== undefined,
      mockEnabled: file.mockEnabled,
      mockControlAvailable: this.profile === 'local-vps',
      methods,
      connections,
      selection: selection ?? null,
    }
  }

  /**
   * Before any explicit `selection` has ever been stored, the visible selects
   * still need to show something honest: the head of the base routing
   * config's reasoning tier, matched back onto a connection by provider name
   * (a migrated legacy connection's id IS the provider name) or by
   * `connectionId` (a hand-edited `routing.json`).
   */
  private deriveDisplaySelection(file: ConnectionsFile): ModelConnectionSelection | undefined {
    const base = loadRoutingConfig(this.rootDir)
    const head = base.tiers.reasoning[0]
    if (!head) return undefined
    const match = file.connections.find(
      (connection) => connection.id === head.provider || connection.id === head.connectionId,
    )
    return match ? { connectionId: match.id, modelId: head.modelId } : undefined
  }

  // ---------------------------------------------------------------------
  // Refresh singleflight
  // ---------------------------------------------------------------------

  /**
   * Coalesces concurrent refreshes of the same connection into one adapter
   * call: the map is checked and populated synchronously, before the first
   * `await`, so two callers arriving in the same tick share the same
   * in-flight promise rather than issuing two calls to the provider.
   */
  private refreshInternal(id: string, challenge?: DeviceChallenge): Promise<RefreshResult> {
    const inflight = this.inflightRefresh.get(id)
    if (inflight) return inflight

    const run = (async (): Promise<RefreshResult> => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)
      return adapter.refresh(this.contextFor(id, record.secretRef), challenge)
    })()

    this.inflightRefresh.set(id, run)
    run
      .finally(() => {
        if (this.inflightRefresh.get(id) === run) this.inflightRefresh.delete(id)
      })
      .catch(() => {
        // The caller of `run` observes the rejection; this branch exists only
        // to keep the singleflight cleanup from becoming an unhandled
        // rejection of its own.
      })
    return run
  }

  /** Runs the singleflight refresh, then applies its result to the persisted record inside the mutation queue. */
  private async applyRefreshResult(
    id: string,
    challenge?: DeviceChallenge,
  ): Promise<ModelConnection> {
    const result = await this.refreshInternal(id, challenge)
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)

      let updated = withState(record, {
        state: result.state,
        stateAt: this.now().toISOString(),
        lastRefreshAt: this.now().toISOString(),
        ...(result.reason === undefined ? {} : { stateReason: result.reason }),
        ...(result.account === undefined ? {} : { account: result.account }),
      })

      if (result.state === 'connected') {
        this.challenges.delete(id)
        const entries = await adapter.catalog(this.contextFor(id, updated.secretRef))
        updated = {
          ...updated,
          catalog: this.applyRoutable(adapter, entries),
          catalogFetchedAt: this.now().toISOString(),
        }
      }

      const nextFile = this.replaceRecord(file, updated)
      this.persist(nextFile)
      return this.connectionWire(updated)
    })
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  async snapshot(): Promise<ModelConnectionsSnapshot> {
    const file = loadConnectionsConfig(this.rootDir)
    return this.buildSnapshot(file)
  }

  async create(request: CreateModelConnectionRequest): Promise<ModelConnectionsSnapshot> {
    return this.queue(async () => {
      const adapter = this.findAdapter(request.method)
      const availability = await this.getAvailability(adapter)
      if (!availability.available) {
        throw new ModelConnectionError('unsupported', availability.reason)
      }

      const id = randomUUID()
      const stateAt = this.now().toISOString()
      const label = request.label ?? `${adapter.providerDisplayName} · ${adapter.methodDisplayName}`

      let record: ModelConnectionRecord = {
        id,
        method: adapter.methodId,
        provider: adapter.providerName,
        label,
        state: 'available',
        stateAt,
        enabledForFallback: false,
        createdAt: stateAt,
      }

      if (adapter.capabilities.authorization === 'api-key' && request.apiKey !== undefined) {
        const secretRef = `secret://vault/${id}-api-key`
        try {
          const result = await adapter.authorize(this.contextFor(id, secretRef), {
            apiKey: request.apiKey,
          })
          if (result.state === 'connected') {
            record = withState(record, {
              state: 'verifying',
              stateAt: this.now().toISOString(),
              secretRef,
              ...(result.account === undefined ? {} : { account: result.account }),
            })
            const entries = await adapter.catalog(this.contextFor(id, secretRef))
            record = {
              ...record,
              state: 'connected',
              stateAt: this.now().toISOString(),
              catalog: this.applyRoutable(adapter, entries),
              catalogFetchedAt: this.now().toISOString(),
            }
          } else {
            this.challenges.set(id, result.challenge)
            record = withState(record, {
              state: 'waiting-for-user',
              stateAt: this.now().toISOString(),
              secretRef,
            })
          }
        } catch (error) {
          const err = connectionErrorFrom(error)
          record = withState(record, {
            state: 'failed',
            stateAt: this.now().toISOString(),
            stateReason: err.message,
            secretRef,
          })
        }
      }

      const file = loadConnectionsConfig(this.rootDir)
      const nextFile: ConnectionsFile = { ...file, connections: [...file.connections, record] }
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  async authorize(
    id: string,
    input: AuthorizeModelConnectionRequest,
  ): Promise<ModelConnectionsSnapshot> {
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)

      if (adapter.capabilities.authorization === 'api-key' && input.apiKey === undefined) {
        throw new ModelConnectionError(
          'rejected',
          'this connection is an API-key connection: submit the replacement key',
        )
      }
      if (adapter.capabilities.authorization === 'device-code' && input.apiKey !== undefined) {
        throw new ModelConnectionError(
          'rejected',
          "this connection re-authorizes through the provider's device code: submit an empty body",
        )
      }

      // A fabricated vault secretRef only ever makes sense for an api-key
      // method — a device-code connection (Codex, in a later slice) owns its
      // credentials through `codexHome` instead and must never be stamped
      // with a bogus vault reference here.
      const secretRef =
        adapter.capabilities.authorization === 'api-key'
          ? (record.secretRef ?? `secret://vault/${id}-api-key`)
          : record.secretRef
      let working = withState(record, {
        state: 'authorizing',
        stateAt: this.now().toISOString(),
      })

      try {
        const result = await adapter.authorize(
          this.contextFor(id, secretRef),
          input.apiKey === undefined ? {} : { apiKey: input.apiKey },
        )
        if (result.state === 'connected') {
          working = withState(working, {
            state: 'verifying',
            stateAt: this.now().toISOString(),
            ...(secretRef === undefined ? {} : { secretRef }),
            ...(result.account === undefined ? {} : { account: result.account }),
          })
          const entries = await adapter.catalog(this.contextFor(id, secretRef))
          working = {
            ...working,
            state: 'connected',
            stateAt: this.now().toISOString(),
            catalog: this.applyRoutable(adapter, entries),
            catalogFetchedAt: this.now().toISOString(),
          }
          this.challenges.delete(id)
        } else {
          this.challenges.set(id, result.challenge)
          working = withState(working, {
            state: 'waiting-for-user',
            stateAt: this.now().toISOString(),
            ...(secretRef === undefined ? {} : { secretRef }),
          })
        }
      } catch (error) {
        const err = connectionErrorFrom(error)
        working = withState(working, {
          state: 'failed',
          stateAt: this.now().toISOString(),
          stateReason: err.message,
          ...(secretRef === undefined ? {} : { secretRef }),
        })
      }

      const nextFile = this.replaceRecord(file, working)
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  /** The polling read: resolves an expired device challenge, otherwise runs the singleflight refresh before returning the wire shape. */
  async read(id: string): Promise<ModelConnection> {
    const file = loadConnectionsConfig(this.rootDir)
    const record = this.findRecord(file, id)

    if (record.state === 'waiting-for-user') {
      const challenge = this.challenges.get(id)
      if (challenge && this.now().getTime() > new Date(challenge.expiresAt).getTime()) {
        return this.queue(() => {
          this.challenges.delete(id)
          const current = loadConnectionsConfig(this.rootDir)
          const currentRecord = this.findRecord(current, id)
          const failed = withState(currentRecord, {
            state: 'failed',
            stateAt: this.now().toISOString(),
            stateReason: 'the device code expired before it was entered; start authorization again',
          })
          const nextFile = this.replaceRecord(current, failed)
          this.persist(nextFile)
          return this.connectionWire(failed)
        })
      }
    }

    if (!REFRESHABLE_STATES.includes(record.state)) return this.connectionWire(record)

    return this.applyRefreshResult(id, this.challenges.get(id))
  }

  async catalog(id: string): Promise<ModelCatalogEntry[]> {
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)
      const entries = await adapter.catalog(this.contextFor(id, record.secretRef))
      const routable = this.applyRoutable(adapter, entries)
      const updated: ModelConnectionRecord = {
        ...record,
        catalog: routable,
        catalogFetchedAt: this.now().toISOString(),
      }
      const nextFile = this.replaceRecord(file, updated)
      this.persist(nextFile)
      return routable
    })
  }

  async verify(id: string, modelId: string): Promise<void> {
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)

      await adapter.verify(this.contextFor(id, record.secretRef), modelId)

      const updated = withState(record, {
        state: 'connected',
        stateAt: this.now().toISOString(),
        selectedModelId: modelId,
      })
      const nextFile = this.replaceRecord(file, updated)
      this.persist(nextFile)
    })
  }

  async update(id: string, patch: UpdateModelConnectionRequest): Promise<ModelConnectionsSnapshot> {
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const updated: ModelConnectionRecord = {
        ...record,
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.enabledForFallback === undefined
          ? {}
          : { enabledForFallback: patch.enabledForFallback }),
      }
      const nextFile = this.replaceRecord(file, updated)
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  async remove(id: string): Promise<ModelConnectionsSnapshot> {
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)

      try {
        await adapter.revoke(this.contextFor(id, record.secretRef))
      } catch {
        // Tolerate a failed provider-side revoke: the record is still
        // removed locally, but the note the adapter would have returned is
        // lost — a future retry against the provider's own console is the
        // fallback, same as any `revocation: 'provider'` method.
      }

      this.challenges.delete(id)
      const connections = file.connections.filter((candidate) => candidate.id !== id)
      const selection = file.selection?.connectionId === id ? undefined : file.selection
      const nextFile: ConnectionsFile = {
        ...file,
        connections,
        ...(selection ? { selection } : {}),
      }
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  /** R3 step 1: validates the target and returns the WOULD-BE file plus the generation it was computed against. Nothing is written. */
  async applySelectionPrepared(connectionId: string, modelId: string): Promise<PreparedSelection> {
    return this.queue(() => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, connectionId)
      if (record.state !== 'connected') {
        throw new ModelConnectionError('rejected', 'this connection is not connected')
      }
      const inCatalog = record.catalog?.some((entry) => entry.id === modelId) ?? false
      if (!inCatalog) {
        throw new ModelConnectionError('rejected', "that model is not in this connection's catalog")
      }

      const updatedRecord: ModelConnectionRecord = { ...record, selectedModelId: modelId }
      const nextFile: ConnectionsFile = {
        ...file,
        connections: file.connections.map((candidate) =>
          candidate.id === connectionId ? updatedRecord : candidate,
        ),
        selection: { connectionId, modelId },
      }
      return { candidateFile: ConnectionsFileSchema.parse(nextFile), generation: this.generation }
    })
  }

  /** R3 step 3: rejects with the try-again reason if anything else mutated the file while the caller's probe (run outside the queue) was in flight; otherwise commits atomically. */
  async commitSelection(prepared: PreparedSelection): Promise<void> {
    return this.queue(() => {
      if (this.generation !== prepared.generation) {
        throw new ModelConnectionError(
          'rejected',
          'the Model connections changed while the model test was running; try again',
        )
      }
      this.persist(prepared.candidateFile)
    })
  }

  /** The route enforces the 409 for a non-`local-vps` profile; the registry only ever persists. */
  async setMockEnabled(enabled: boolean): Promise<ModelConnectionsSnapshot> {
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const nextFile: ConnectionsFile = { ...file, mockEnabled: enabled }
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  /** Public singleflight refresh: forces the adapter call regardless of `ensureFresh`'s freshness window. */
  async refresh(id: string): Promise<ModelConnection> {
    return this.applyRefreshResult(id, this.challenges.get(id))
  }

  /**
   * Pre-inference freshness check: a no-op for a `refresh: 'static'` method
   * (BYOK has nothing to refresh) and for a connection refreshed within the
   * last five minutes, so a chat turn never pays for a redundant provider
   * round-trip on every call.
   */
  async ensureFresh(id: string): Promise<void> {
    const file = loadConnectionsConfig(this.rootDir)
    const record = this.findRecord(file, id)
    const adapter = this.findAdapter(record.method)
    if (adapter.capabilities.refresh === 'static') return
    const last = record.lastRefreshAt ? new Date(record.lastRefreshAt).getTime() : undefined
    if (last !== undefined && this.now().getTime() - last < ENSURE_FRESH_WINDOW_MS) return
    await this.applyRefreshResult(id, this.challenges.get(id))
  }

  /**
   * Maps a live-call failure onto the connection it came from (R5): a
   * migrated legacy connection's id IS its provider name, so an unbound
   * legacy `ModelRef` (no `connectionId`) still resolves here when the
   * caller passes `model.connectionId ?? model.provider`. No match is a
   * silent no-op — a candidate with no matching record was never a Model
   * connection to begin with.
   */
  async noteCallFailure(idOrProvider: string, error: unknown): Promise<void> {
    return this.queue(() => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = file.connections.find((candidate) => candidate.id === idOrProvider)
      if (!record) return

      const err = connectionErrorFrom(error)
      const state: ConnectionLifecycleState =
        err.code === 'expired' ? 'expired' : err.code === 'unauthorized' ? 'revoked' : 'failed'
      const updated = withState(record, {
        state,
        stateAt: this.now().toISOString(),
        stateReason: err.message,
      })
      const nextFile = this.replaceRecord(file, updated)
      this.persist(nextFile)
    })
  }

  /**
   * Placeholder for the inference slice: once a subscription adapter
   * (Codex) exists, this turns every `connected` connection into the
   * runtime descriptor `pi-provider-bridge.ts` needs to route a turn.
   * Typed against the real `ModelConnectionRuntime` shape already (issue
   * #47's boot wiring, `server.ts`) — returning nothing yet — so
   * `server.ts`'s `connections: () => registry.runtimes()` wiring lands
   * once instead of being threaded through twice.
   */
  runtimes(): ModelConnectionRuntime[] {
    return []
  }

  /**
   * Boot-time normalization (ADR-0014 amendment): any state a restart could
   * have interrupted mid-flight is never trusted — it is moved to `failed`
   * with a reason the user can act on, and any in-memory challenge for it is
   * dropped (a restart already lost that material). Synchronous and called
   * once, before anything else touches the registry.
   */
  normalizeInFlightStatesOnBoot(): void {
    const file = loadConnectionsConfig(this.rootDir)
    let changed = false
    const connections = file.connections.map((record) => {
      if (!IN_FLIGHT_STATES.includes(record.state)) return record
      changed = true
      this.challenges.delete(record.id)
      return withState(record, {
        state: 'failed',
        stateAt: this.now().toISOString(),
        stateReason: INTERRUPTED_AUTHORIZATION_REASON,
      })
    })
    if (!changed) return
    this.persist({ ...file, connections })
  }

  /**
   * Shared by boot and the importer: creates one `connected` connection per
   * BYOK provider that has a resolvable vault key and no connection yet,
   * under the reserved legacy id (`id === provider`) so a pre-existing
   * `secret://vault/<name>` keeps resolving under the same name it always
   * had. Idempotent — an existing record for the provider is left untouched.
   */
  async reconcileImportedKeys(vaultNames: readonly string[]): Promise<void> {
    return this.queue(() => {
      const file = loadConnectionsConfig(this.rootDir)
      let connections = file.connections
      let changed = false

      for (const name of vaultNames) {
        const provider = ByokProviderSchema.safeParse(name)
        if (!provider.success) continue
        if (connections.some((candidate) => candidate.id === provider.data)) continue
        const adapter = this.adapters.find(
          (candidate) =>
            candidate.providerName === provider.data &&
            candidate.capabilities.authorization === 'api-key',
        )
        if (!adapter) continue

        const stateAt = this.now().toISOString()
        const record: ModelConnectionRecord = {
          id: provider.data,
          method: adapter.methodId,
          provider: provider.data,
          label: `${adapter.providerDisplayName} · ${adapter.methodDisplayName}`,
          state: 'connected',
          stateAt,
          enabledForFallback: false,
          createdAt: stateAt,
          secretRef: `secret://vault/${name}`,
        }
        connections = [...connections, record]
        changed = true
      }

      if (!changed) return
      this.persist({ ...file, connections })
    })
  }
}
