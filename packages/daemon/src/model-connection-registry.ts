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
  type AuthorizeInput,
  type ModelConnectionAdapter,
  type RefreshResult,
} from './model-connection-adapter.ts'
import type { CodexTransport } from './codex-app-server.ts'
import { loadRoutingConfig, saveRoutingConfig, type SecretResolver } from './model-routing.ts'
import type { ModelConnectionRuntime, SubscriptionStreamRequest } from './pi-provider-bridge.ts'
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
  /** Injected so the registry never has to import `pi-provider-bridge.ts` to know what this build can route to (issue #47). */
  isRoutableModel: (provider: string, modelId: string) => boolean
  /** Fired after every mutation that persists `connections.json`, so `server.ts` can rebuild and swap the live routing config with no restart. */
  onRoutingChanged?: (file: ConnectionsFile) => void
  env: NodeJS.ProcessEnv
  /**
   * Backs every Codex connection's `AdapterContext.codexTransport` (issue
   * #47): `server.ts` supplies `(id, codexHome) => codexSessionPool.get(id,
   * codexHome)`, so every verb the Codex adapter runs against the same
   * connection shares one pooled app-server process instead of spawning a
   * fresh one per call. Absent in every test that never authorizes a Codex
   * connection.
   */
  codexSession?: (connectionId: string, codexHome: string) => Promise<CodexTransport>
  /**
   * Fired at the end of every `noteCallFailure` call, regardless of which
   * caller reached it (issue #47): the router's `onCallError` for a legacy
   * BYOK 401/403, or `connection-inference.ts`'s wrapper for a subscription
   * turn that failed mid-stream. Centralizing this here — rather than
   * letting each caller decide separately whether to notify — is what makes
   * `server.ts`'s reconnect system notice fire for both paths from one
   * place instead of two.
   */
  onCallFailure?: (connectionId: string, state: ConnectionLifecycleState) => void
}

/** The result of `applySelectionPrepared`'s step 1 (issue #47's verify-then-commit selection flow): the WOULD-BE file, never written yet, plus the generation it was computed against. */
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
 * The fields every freshly-created record shares (issue #47): `create` and
 * `reconcileImportedKeys` each build one from an adapter plus a lifecycle
 * state, differing only in `id`, `label`, and any `secretRef`.
 */
function newRecordFields(
  id: string,
  adapter: ModelConnectionAdapter,
  stateAt: string,
  state: ConnectionLifecycleState,
): Pick<
  ModelConnectionRecord,
  'id' | 'method' | 'provider' | 'state' | 'stateAt' | 'enabledForFallback' | 'createdAt'
> {
  return {
    id,
    method: adapter.methodId,
    provider: adapter.providerName,
    state,
    stateAt,
    enabledForFallback: false,
    createdAt: stateAt,
  }
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
 * the compare-and-swap counter (issue #47's verify-then-commit selection
 * flow) that lets `applySelectionPrepared`/`commitSelection` detect a
 * connection change that happened while a model-selection probe was running
 * outside the queue.
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
  private readonly codexSession:
    ((connectionId: string, codexHome: string) => Promise<CodexTransport>) | undefined
  private readonly onCallFailure:
    ((connectionId: string, state: ConnectionLifecycleState) => void) | undefined

  private tail: Promise<unknown> = Promise.resolve()
  private generation = 0
  private readonly inflightRefresh = new Map<
    string,
    { promise: Promise<RefreshResult>; challenge: DeviceChallenge | undefined }
  >()
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
    this.codexSession = options.codexSession
    this.onCallFailure = options.onCallFailure
  }

  /** The compare-and-swap counter (issue #47's verify-then-commit selection flow), read by the route layer before starting a selection probe outside the queue. */
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
      ...(this.codexSession === undefined
        ? {}
        : {
            codexTransport: (options: { codexHome: string }) =>
              this.codexSession!(connectionId, options.codexHome),
          }),
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

  /** `isRoutableModel` never applies to a non-api-key method (device-code/none): a subscription connection's catalog is always routable (issue #47). */
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
   * in-flight promise rather than issuing two calls to the provider. The
   * challenge each caller is polling for is part of the coalescing key
   * (issue #47): a refresh started against a PREVIOUS challenge must never
   * be handed to a caller polling a NEWER one (a reauthorization installed a
   * fresh device challenge while the old refresh was still in flight) — that
   * caller instead waits for the stale call to settle (so the same
   * connection is never hit by two overlapping adapter calls), then issues
   * its own fresh refresh against the challenge it actually holds. Two
   * callers sharing the exact same challenge (including two callers with no
   * challenge at all — `undefined === undefined`) still join one call, same
   * as before.
   */
  private refreshInternal(id: string, challenge?: DeviceChallenge): Promise<RefreshResult> {
    const inflight = this.inflightRefresh.get(id)
    if (inflight) {
      if (inflight.challenge === challenge) return inflight.promise
      return inflight.promise.then(
        () => this.refreshInternal(id, challenge),
        () => this.refreshInternal(id, challenge),
      )
    }

    const run = (async (): Promise<RefreshResult> => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      const adapter = this.findAdapter(record.method)
      return adapter.refresh(this.contextFor(id, record.secretRef), challenge)
    })()

    this.inflightRefresh.set(id, { promise: run, challenge })
    run
      .finally(() => {
        if (this.inflightRefresh.get(id)?.promise === run) this.inflightRefresh.delete(id)
      })
      .catch(() => {
        // The caller of `run` observes the rejection; this branch exists only
        // to keep the singleflight cleanup from becoming an unhandled
        // rejection of its own.
      })
    return run
  }

  /**
   * Runs the singleflight refresh, then applies its result to the persisted
   * record inside the mutation queue. Compare-and-swap (issue #47): the
   * record's `state`/`stateAt` pre-image is captured BEFORE the singleflight
   * call even starts, so a caller that mutated this same connection (a
   * reauthorization, a `noteCallFailure`, another refresh) while the adapter
   * call was in flight is detected once the queued apply step actually runs
   * — a mismatch means this result is stale, and it is discarded rather than
   * clobbering whatever that newer mutation wrote; the caller returns the
   * CURRENT record, unmodified. The in-memory device challenge is deleted
   * only when it is still the exact object this call was given — a
   * reauthorization that already replaced it with a fresh challenge must
   * never have that new challenge erased by this stale result.
   */
  private async applyRefreshResult(
    id: string,
    challenge?: DeviceChallenge,
  ): Promise<ModelConnection> {
    const preFile = loadConnectionsConfig(this.rootDir)
    const preRecord = this.findRecord(preFile, id)
    const preImage = { state: preRecord.state, stateAt: preRecord.stateAt }

    const result = await this.refreshInternal(id, challenge)
    return this.queue(async () => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = this.findRecord(file, id)
      if (record.state !== preImage.state || record.stateAt !== preImage.stateAt) {
        return this.connectionWire(record)
      }
      const adapter = this.findAdapter(record.method)

      let updated = withState(record, {
        state: result.state,
        stateAt: this.now().toISOString(),
        lastRefreshAt: this.now().toISOString(),
        ...(result.reason === undefined ? {} : { stateReason: result.reason }),
        ...(result.account === undefined ? {} : { account: result.account }),
      })

      if (result.state === 'connected') {
        if (this.challenges.get(id) === challenge) this.challenges.delete(id)
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
        ...newRecordFields(id, adapter, stateAt, 'available'),
        label,
      }

      if (adapter.capabilities.authorization === 'api-key' && request.apiKey !== undefined) {
        record = await this.runAuthorization(record, adapter, { apiKey: request.apiKey })
      }

      const file = loadConnectionsConfig(this.rootDir)
      const nextFile: ConnectionsFile = { ...file, connections: [...file.connections, record] }
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  /**
   * The authorize → 'verifying' → catalog → 'connected'/'failed'
   * (or 'waiting-for-user') state machine shared by `create` and
   * `authorize` (issue #47) — previously duplicated between the two.
   * Computes the secretRef fresh rather than trusting whatever `record`
   * already carries: for an `authorization: 'api-key'` adapter, a
   * successful authorize ALWAYS repoints the record at THIS connection's own
   * `secret://vault/<id>-api-key` entry — the adapter's own `authorize`
   * (`model-connection-byok.ts`) just stored the new key there, so the
   * record must follow it, replacing any previous reference (a migrated
   * legacy `secret://env/…` ref included). The old environment variable, if
   * any, is left exactly where it was; the record simply stops resolving
   * through it. A non-api-key (device-code) adapter passes `record.secretRef`
   * through unchanged — Codex owns its own credentials under `codexHome`
   * and is never stamped with a vault reference here.
   */
  private async runAuthorization(
    record: ModelConnectionRecord,
    adapter: ModelConnectionAdapter,
    input: AuthorizeInput,
  ): Promise<ModelConnectionRecord> {
    const id = record.id
    const secretRef =
      adapter.capabilities.authorization === 'api-key'
        ? `secret://vault/${id}-api-key`
        : record.secretRef

    try {
      const result = await adapter.authorize(this.contextFor(id, secretRef), input)
      if (result.state === 'connected') {
        const verifying = withState(record, {
          state: 'verifying',
          stateAt: this.now().toISOString(),
          ...(secretRef === undefined ? {} : { secretRef }),
          ...(result.account === undefined ? {} : { account: result.account }),
        })
        const entries = await adapter.catalog(this.contextFor(id, secretRef))
        this.challenges.delete(id)
        return {
          ...verifying,
          state: 'connected',
          stateAt: this.now().toISOString(),
          catalog: this.applyRoutable(adapter, entries),
          catalogFetchedAt: this.now().toISOString(),
        }
      }
      this.challenges.set(id, result.challenge)
      return withState(record, {
        state: 'waiting-for-user',
        stateAt: this.now().toISOString(),
        ...(secretRef === undefined ? {} : { secretRef }),
      })
    } catch (error) {
      const err = connectionErrorFrom(error)
      return withState(record, {
        state: 'failed',
        stateAt: this.now().toISOString(),
        stateReason: err.message,
        ...(secretRef === undefined ? {} : { secretRef }),
      })
    }
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

      const authorizing = withState(record, {
        state: 'authorizing',
        stateAt: this.now().toISOString(),
      })
      const working = await this.runAuthorization(
        authorizing,
        adapter,
        input.apiKey === undefined ? {} : { apiKey: input.apiKey },
      )

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
    // A subscription probe performs the same pre-inference freshness check
    // as a real turn. Run that check, and then the provider I/O itself,
    // outside the mutation queue: an automatic refresh persists through
    // this queue, so holding it across the probe would make each operation
    // wait forever for the other (issue #47).
    await this.ensureFresh(id)

    const file = loadConnectionsConfig(this.rootDir)
    const record = this.findRecord(file, id)
    const adapter = this.findAdapter(record.method)
    const generation = this.generation

    await adapter.verify(this.contextFor(id, record.secretRef), modelId)

    return this.queue(() => {
      if (this.generation !== generation) {
        throw new ModelConnectionError(
          'rejected',
          'the Model connections changed while the model test was running; try again',
        )
      }
      const currentFile = loadConnectionsConfig(this.rootDir)
      const currentRecord = this.findRecord(currentFile, id)
      const updated = withState(currentRecord, {
        state: 'connected',
        stateAt: this.now().toISOString(),
        selectedModelId: modelId,
      })
      const nextFile = this.replaceRecord(currentFile, updated)
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

  /**
   * An env-backed key (issue #47) is never Veduta's to delete: the
   * environment variable stays alive underneath the daemon regardless of
   * what this method does, so removing the connection replaces the record
   * with a `'revoked'` tombstone instead of dropping it — the id survives,
   * so a boot-time migration (`model-connection-migration.ts`'s
   * `reconcileByokConnections`, which skips any id that already has a
   * record) can never resurrect it as a fresh `'connected'` connection the
   * moment the daemon restarts.
   *
   * A reserved legacy provider id (`id` is `'anthropic'`/`'openai'`/
   * `'openrouter'`) gets the same tombstone treatment even once its
   * `secretRef` has been repointed at the vault by a later reauthorization
   * (`runAuthorization`): `routing.json`'s `providerKeys` entry for that
   * provider is untouched by this method (only `connectionKeys` is), so
   * deleting the record outright would leave that legacy pointer as the
   * only trace of the provider — exactly what `reconcileByokConnections`
   * treats as "never migrated yet" and turns back into a fresh `'connected'`
   * connection on the next boot. Keeping the id occupied, in whatever state,
   * is what blocks that resurrection. The vault entry a reauthorization
   * created is still gone — `adapter.revoke` above already deleted it, since
   * it ran against this record's CURRENT (vault-backed) `secretRef`.
   *
   * A vault-backed or keyless connection with no reserved id has no such
   * survivor to account for and is deleted outright, as before.
   */
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
      const selection = file.selection?.connectionId === id ? undefined : file.selection
      const isEnvBacked = record.secretRef?.startsWith('secret://env/') === true
      const isReservedProviderId = ByokProviderSchema.safeParse(id).success
      const tombstoneReason = isEnvBacked
        ? 'the key comes from the daemon environment and stays there; remove the environment variable to retire it'
        : "the daemon's legacy provider configuration still references this provider; the tombstone keeps it retired"
      const connections =
        isEnvBacked || isReservedProviderId
          ? file.connections.map((candidate) =>
              candidate.id === id
                ? withState(candidate, {
                    state: 'revoked',
                    stateAt: this.now().toISOString(),
                    stateReason: tombstoneReason,
                  })
                : candidate,
            )
          : file.connections.filter((candidate) => candidate.id !== id)
      // `selection` must be dropped from `file` FIRST, not merely left
      // un-overridden: spreading `...file` already copies its `selection`
      // key onto `nextFile`, so a later conditional spread that omits
      // `selection` (the removed-id case) would otherwise leave the STALE
      // value in place rather than actually clearing it.
      const { selection: _droppedSelection, ...fileWithoutSelection } = file
      const nextFile: ConnectionsFile = {
        ...fileWithoutSelection,
        connections,
        ...(selection ? { selection } : {}),
      }
      // A legacy hand-edited `routing.json` may still carry this id's
      // `connectionKeys` entry (issue #47): dropped BEFORE `persist` below,
      // not after — `persist` synchronously fires `onRoutingChanged`, which
      // rebuilds the live routing config from `routing.json` as it stands
      // AT THAT MOMENT. Dropping the pointer afterward would let that
      // rebuild still see the stale entry and keep the removed connection's
      // route live until the next unrelated mutation happened to trigger
      // another rebuild.
      this.dropRoutingConnectionKey(id)
      this.persist(nextFile)
      return this.buildSnapshot(nextFile)
    })
  }

  /** Drops `routing.json`'s `connectionKeys[id]` entry, if any — see `remove`'s own doc comment. */
  private dropRoutingConnectionKey(id: string): void {
    const routing = loadRoutingConfig(this.rootDir)
    if (routing.connectionKeys[id] === undefined) return
    const { [id]: _dropped, ...connectionKeys } = routing.connectionKeys
    saveRoutingConfig(this.rootDir, { ...routing, connectionKeys })
  }

  /** Step 1 of the verify-then-commit selection flow (issue #47): validates the target and returns the WOULD-BE file plus the generation it was computed against. Nothing is written. */
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

  /** Step 3 of the verify-then-commit selection flow (issue #47): rejects with the try-again reason if anything else mutated the file while the caller's probe (run outside the queue) was in flight; otherwise commits atomically. */
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
   * round-trip on every call. Returns `undefined` for either skip case, or
   * the connection's lifecycle state AFTER a refresh actually ran (issue
   * #47): `connection-inference.ts`'s wrapper reads this to refuse a turn on
   * a connection that just turned out to be revoked/expired, BEFORE ever
   * calling the adapter's own `stream` verb, rather than only reacting to a
   * failure mid-call.
   *
   * The current record's own state is read FIRST, before either skip check
   * (issue #47): a connection that is already revoked/expired/failed must
   * never fall through the static-method skip or the freshness window and
   * come back as `undefined` — the "no-op, nothing changed" signal a caller
   * reads as "still safe to call the adapter" — just because it happens to
   * have a recent `lastRefreshAt` or a `refresh: 'static'` method. Only a
   * connection that is CURRENTLY `'connected'` reaches either skip check.
   */
  async ensureFresh(id: string): Promise<ConnectionLifecycleState | undefined> {
    const file = loadConnectionsConfig(this.rootDir)
    const record = this.findRecord(file, id)
    if (record.state !== 'connected') return record.state
    const adapter = this.findAdapter(record.method)
    if (adapter.capabilities.refresh === 'static') return undefined
    const last = record.lastRefreshAt ? new Date(record.lastRefreshAt).getTime() : undefined
    if (last !== undefined && this.now().getTime() - last < ENSURE_FRESH_WINDOW_MS) return undefined
    const refreshed = await this.applyRefreshResult(id, this.challenges.get(id))
    return refreshed.state
  }

  /**
   * Maps a live-call failure onto the connection it came from (issue #47): a
   * migrated legacy connection's id IS its provider name, so an unbound
   * legacy `ModelRef` (no `connectionId`) still resolves here when the
   * caller passes `model.connectionId ?? model.provider`. No match is a
   * silent no-op — a candidate with no matching record was never a Model
   * connection to begin with. Returns the resulting lifecycle state (or
   * `undefined` for the no-op case) so a caller can react to a
   * revoked/expired transition — `server.ts`'s reconnect system notice
   * (issue #47) and `connection-inference.ts`'s own `noteCallFailure` call
   * both read this.
   */
  async noteCallFailure(
    idOrProvider: string,
    error: unknown,
  ): Promise<ConnectionLifecycleState | undefined> {
    return this.queue(() => {
      const file = loadConnectionsConfig(this.rootDir)
      const record = file.connections.find((candidate) => candidate.id === idOrProvider)
      if (!record) return undefined

      const err = connectionErrorFrom(error)
      const state = lifecycleStateAfterFailure(err.code)
      const updated = withState(record, {
        state,
        stateAt: this.now().toISOString(),
        stateReason: err.message,
      })
      const nextFile = this.replaceRecord(file, updated)
      this.persist(nextFile)
      this.onCallFailure?.(record.id, state)
      return state
    })
  }

  /**
   * Every `connected` connection as a `pi-provider-bridge.ts`
   * `ModelConnectionRuntime` (issue #47): `'subscription'` transport for any
   * connection whose adapter implements `stream` (`model-connection-adapter.ts`'s
   * doc comment on that member — only Codex today, but the check is
   * adapter-authoritative, not a hardcoded method id, so a future
   * subscription adapter needs no change here), `'builtin'` for everything
   * else. The `stream` member here calls the adapter directly, with NO
   * freshness check and NO failure-state mapping — `connection-inference.ts`'s
   * `createConnectionRuntimes` is the one place that wraps it with
   * `ensureFresh`/`noteCallFailure` before `server.ts` ever hands this array
   * to the provider bridge; this method stays a plain, synchronous snapshot
   * of what the registry currently knows.
   */
  runtimes(): ModelConnectionRuntime[] {
    const file = loadConnectionsConfig(this.rootDir)
    return file.connections
      .filter((record) => record.state === 'connected')
      .map((record) => {
        const adapter = this.findAdapter(record.method)
        const transport: ModelConnectionRuntime['transport'] =
          adapter.stream !== undefined ? 'subscription' : 'builtin'
        if (transport !== 'subscription') {
          return { connectionId: record.id, provider: record.provider, transport }
        }
        const context = this.contextFor(record.id, record.secretRef)
        const adapterStream = adapter.stream!
        return {
          connectionId: record.id,
          provider: record.provider,
          transport,
          stream: (request: SubscriptionStreamRequest) => adapterStream(context, request),
        }
      })
  }

  /**
   * Sync (issue #47): `PiAgentRunner`'s `toolsEnabledForModel` gate runs on
   * every `prompt()` call, so it cannot await a mutation-queue read — this
   * reads `connections.json` directly, the same way `deriveDisplaySelection`
   * already does outside the queue for a read-only lookup. `false`
   * (tools allowed) for any id with no matching record: a stale/removed
   * connection is the router's problem to refuse, not this gate's.
   */
  isTextOnly(connectionId: string): boolean {
    const file = loadConnectionsConfig(this.rootDir)
    const record = file.connections.find((candidate) => candidate.id === connectionId)
    if (!record) return false
    return !this.findAdapter(record.method).capabilities.vedutaTools
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
          ...newRecordFields(provider.data, adapter, stateAt, 'connected'),
          label: `${adapter.providerDisplayName} · ${adapter.methodDisplayName}`,
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

function lifecycleStateAfterFailure(
  code: ReturnType<typeof connectionErrorFrom>['code'],
): ConnectionLifecycleState {
  if (code === 'expired') return 'expired'
  if (code === 'unauthorized') return 'revoked'
  return 'failed'
}
