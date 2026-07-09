import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ModelRef, ModelTier } from './agent-runner.ts'

/**
 * Per-call model routing (issue #10, ADR-0002): the usage map decides the
 * tier, the router picks the ModelRef, fails over across providers, and
 * enforces the daily spending caps (BYOK transparency).
 */
export type CallPurpose =
  | 'chat-turn'
  | 'classification'
  | 'mechanical-update'
  | 'quarantined-reader'
  | 'heartbeat'
  | 'worker'

export type CallOrigin = 'user' | 'proactive'

export interface RouteRequest {
  purpose: CallPurpose
  /** Explicit, never defaulted: past the cap only user-origin calls survive. */
  origin: CallOrigin
  spaceId?: string
  workerId?: string
  /** Workers declare their tier in the briefing. */
  workerTier?: ModelTier
}

export function tierForRequest(request: RouteRequest): ModelTier {
  if (request.purpose === 'worker') {
    if (request.origin !== 'proactive') {
      throw new Error('Worker calls are always proactive; origin cannot bypass the caps')
    }
    if (!request.workerTier) {
      throw new Error('Worker calls must declare their tier in the briefing')
    }
    return request.workerTier
  }
  return request.purpose === 'chat-turn' ? 'reasoning' : 'triage'
}

export const SecretRefSchema = z
  .string()
  .regex(/^secret:\/\/.+$/, 'provider keys must be secret:// references, never plaintext')

const TierModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
})

export const RoutingConfigSchema = z.object({
  tiers: z.object({
    triage: z.array(TierModelSchema).min(1),
    reasoning: z.array(TierModelSchema).min(1),
  }),
  providerKeys: z.record(SecretRefSchema),
  dailyCapUsd: z.object({
    triage: z.number().positive(),
    reasoning: z.number().positive(),
  }),
})

export type RoutingConfig = z.infer<typeof RoutingConfigSchema>

const RoutingOverridesSchema = z.object({
  tiers: z
    .object({
      triage: z.array(TierModelSchema).min(1).optional(),
      reasoning: z.array(TierModelSchema).min(1).optional(),
    })
    .optional(),
  providerKeys: z.record(SecretRefSchema).optional(),
  dailyCapUsd: z
    .object({
      triage: z.number().positive().optional(),
      reasoning: z.number().positive().optional(),
    })
    .optional(),
})

export function defaultRoutingConfig(): RoutingConfig {
  return {
    tiers: {
      reasoning: [
        { provider: 'anthropic', modelId: 'claude-sonnet-5' },
        { provider: 'openai', modelId: 'gpt-5.5' },
        { provider: 'openrouter', modelId: 'anthropic/claude-sonnet-5' },
      ],
      triage: [
        { provider: 'anthropic', modelId: 'claude-haiku-4-5' },
        { provider: 'openai', modelId: 'gpt-5.5-mini' },
        { provider: 'openrouter', modelId: 'anthropic/claude-haiku-4.5' },
      ],
    },
    providerKeys: {
      anthropic: 'secret://env/ANTHROPIC_API_KEY',
      openai: 'secret://env/OPENAI_API_KEY',
      openrouter: 'secret://env/OPENROUTER_API_KEY',
    },
    dailyCapUsd: { triage: 5, reasoning: 20 },
  }
}

/** User overrides live in `<rootDir>/routing.json`, deep-merged over the defaults. */
export function loadRoutingConfig(rootDir: string): RoutingConfig {
  const defaults = defaultRoutingConfig()
  const path = join(rootDir, 'routing.json')
  if (!existsSync(path)) return defaults
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`invalid JSON in routing config ${path}: ${errorText(error)}`)
  }
  const overrides = RoutingOverridesSchema.parse(raw)
  return RoutingConfigSchema.parse({
    tiers: {
      triage: overrides.tiers?.triage ?? defaults.tiers.triage,
      reasoning: overrides.tiers?.reasoning ?? defaults.tiers.reasoning,
    },
    providerKeys: { ...defaults.providerKeys, ...overrides.providerKeys },
    dailyCapUsd: { ...defaults.dailyCapUsd, ...overrides.dailyCapUsd },
  })
}

/**
 * The vault (issue #15) will implement this interface; until then the
 * local profile resolves `secret://env/NAME` from the environment.
 */
export interface SecretResolver {
  resolve(secretRef: string): string | undefined
}

export const envSecretResolver: SecretResolver = {
  resolve(secretRef) {
    const match = /^secret:\/\/env\/(.+)$/.exec(secretRef)
    return match?.[1] ? process.env[match[1]] : undefined
  },
}

export class SpendingCapError extends Error {
  constructor(tier: ModelTier) {
    super(`daily spending cap for the ${tier} tier is exhausted; proactivity is off until tomorrow`)
    this.name = 'SpendingCapError'
  }
}

export class NoAvailableModelError extends Error {
  constructor(tier: ModelTier, skippedProviders: string[]) {
    super(
      `no ${tier} model is available: providers [${skippedProviders.join(', ')}] have no resolvable secret`,
    )
    this.name = 'NoAvailableModelError'
  }
}

export class ModelRoutingExhaustedError extends Error {
  constructor(tier: ModelTier, attempts: number, options: { cause: unknown }) {
    super(`all ${attempts} ${tier} models failed`, options)
    this.name = 'ModelRoutingExhaustedError'
  }
}

/** Marks failures that must never fail over (bad key, invalid request). */
export class NonRetryableModelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonRetryableModelError'
  }
}

export type RouterEvent =
  | {
      type: 'model.failover'
      at: string
      from: ModelRef
      to: ModelRef
      purpose: CallPurpose
      reason: string
      spaceId?: string
    }
  | {
      type: 'spending.cap-exceeded'
      at: string
      tier: ModelTier
      spentUsd: number
      capUsd: number
    }

export interface RoutedCall {
  at: string
  purpose: CallPurpose
  origin: CallOrigin
  model: ModelRef
  outcome: 'ok' | 'error'
  errorMessage?: string
  spaceId?: string
  workerId?: string
}

export interface TierUsage {
  spentUsd: number
  capUsd: number
}

export interface UsageSnapshot {
  date: string
  tiers: Record<ModelTier, TierUsage>
  workers: { workerId: string; spentUsd: number }[]
}

export interface ModelRouterOptions {
  config?: RoutingConfig
  /** When set, calls and spend persist to `<rootDir>/usage/<date>.jsonl`. */
  rootDir?: string
  secrets?: SecretResolver
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  onEvent?: (event: RouterEvent) => void
  isRetryable?: (error: unknown) => boolean
}

const BACKOFF_BASE_MS = 250
const MAX_CALL_LOG = 500
const TIERS: ModelTier[] = ['triage', 'reasoning']

interface DailyUsage {
  date: string
  tiers: Record<ModelTier, number>
  workers: Map<string, number>
  capNotified: Set<ModelTier>
}

export class ModelRouter {
  private readonly config: RoutingConfig
  private readonly rootDir: string | undefined
  private readonly secrets: SecretResolver
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly onEvent: ((event: RouterEvent) => void) | undefined
  private readonly isRetryable: (error: unknown) => boolean
  private readonly calls: RoutedCall[] = []
  private usageToday: DailyUsage

  constructor(options: ModelRouterOptions = {}) {
    this.config = options.config ?? defaultRoutingConfig()
    this.rootDir = options.rootDir
    this.secrets = options.secrets ?? envSecretResolver
    this.now = options.now ?? (() => new Date())
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.onEvent = options.onEvent
    this.isRetryable = options.isRetryable ?? defaultIsRetryable
    this.usageToday = this.restoreUsage(this.today())
  }

  route(request: RouteRequest): ModelRef {
    const tier = tierForRequest(request)
    this.assertSpendingAllowed(request, tier)
    const [primary] = this.candidates(tier)
    if (!primary) throw new NoAvailableModelError(tier, [])
    return primary
  }

  /**
   * One ordered pass over the tier's candidates; failover only on
   * retryable errors. `fn` receives the attempt index so runner calls
   * can mark retries (`retryOfFailedTurn`).
   */
  async execute<T>(
    request: RouteRequest,
    fn: (model: ModelRef, attempt: number) => Promise<T> | T,
  ): Promise<T> {
    const tier = tierForRequest(request)
    this.assertSpendingAllowed(request, tier)
    const candidates = this.candidates(tier)
    let lastError: unknown
    for (const [attempt, model] of candidates.entries()) {
      try {
        const result = await fn(model, attempt)
        this.logCall(request, model, 'ok')
        return result
      } catch (error) {
        const reason = sanitizeErrorText(error)
        this.logCall(request, model, 'error', reason)
        if (!this.isRetryable(error)) throw error
        lastError = error
        const next = candidates[attempt + 1]
        if (next) {
          const failover: RouterEvent = {
            type: 'model.failover',
            at: this.nowIso(),
            from: model,
            to: next,
            purpose: request.purpose,
            reason,
            ...(request.spaceId === undefined ? {} : { spaceId: request.spaceId }),
          }
          this.persist({ kind: 'failover', ...failover })
          this.emit(failover)
          await this.sleep(BACKOFF_BASE_MS * 2 ** attempt)
        }
      }
    }
    throw new ModelRoutingExhaustedError(tier, candidates.length, { cause: lastError })
  }

  recordSpend(model: ModelRef, usd: number, options: { workerId?: string } = {}): void {
    // Non-finite or negative cost means "unreported", never "free credit".
    if (!Number.isFinite(usd) || usd < 0) return
    const usage = this.currentUsage()
    usage.tiers[model.tier] += usd
    if (options.workerId) {
      usage.workers.set(options.workerId, (usage.workers.get(options.workerId) ?? 0) + usd)
    }
    this.persist({
      kind: 'spend',
      at: this.nowIso(),
      tier: model.tier,
      model,
      usd,
      ...(options.workerId === undefined ? {} : { workerId: options.workerId }),
    })
    if (
      usage.tiers[model.tier] > this.config.dailyCapUsd[model.tier] &&
      !usage.capNotified.has(model.tier)
    ) {
      this.notifyCapExceeded(usage, model.tier)
    }
  }

  proactivityAllowed(tier: ModelTier): boolean {
    return this.currentUsage().tiers[tier] <= this.config.dailyCapUsd[tier]
  }

  usage(): UsageSnapshot {
    const usage = this.currentUsage()
    return {
      date: usage.date,
      tiers: {
        triage: { spentUsd: usage.tiers.triage, capUsd: this.config.dailyCapUsd.triage },
        reasoning: { spentUsd: usage.tiers.reasoning, capUsd: this.config.dailyCapUsd.reasoning },
      },
      workers: [...usage.workers.entries()].map(([workerId, spentUsd]) => ({
        workerId,
        spentUsd,
      })),
    }
  }

  callLog(): RoutedCall[] {
    return [...this.calls]
  }

  /** The user hears about a cap once per tier per day, restarts included. */
  private notifyCapExceeded(usage: DailyUsage, tier: ModelTier): void {
    usage.capNotified.add(tier)
    this.persist({ kind: 'cap-notified', at: this.nowIso(), tier })
    this.emit({
      type: 'spending.cap-exceeded',
      at: this.nowIso(),
      tier,
      spentUsd: usage.tiers[tier],
      capUsd: this.config.dailyCapUsd[tier],
    })
  }

  private candidates(tier: ModelTier): ModelRef[] {
    const skipped: string[] = []
    const available = this.config.tiers[tier].flatMap((entry) => {
      const secretRef = this.config.providerKeys[entry.provider]
      // Providers without a configured key entry are keyless (mock, local).
      if (secretRef !== undefined && this.secrets.resolve(secretRef) === undefined) {
        skipped.push(entry.provider)
        return []
      }
      return [{ provider: entry.provider, modelId: entry.modelId, tier }]
    })
    if (available.length === 0) throw new NoAvailableModelError(tier, skipped)
    return available
  }

  private assertSpendingAllowed(request: RouteRequest, tier: ModelTier): void {
    if (request.origin === 'proactive' && !this.proactivityAllowed(tier)) {
      throw new SpendingCapError(tier)
    }
  }

  private logCall(
    request: RouteRequest,
    model: ModelRef,
    outcome: 'ok' | 'error',
    errorText?: string,
  ): void {
    const call: RoutedCall = {
      at: this.nowIso(),
      purpose: request.purpose,
      origin: request.origin,
      model,
      outcome,
      ...(errorText === undefined ? {} : { errorMessage: errorText }),
      ...(request.spaceId === undefined ? {} : { spaceId: request.spaceId }),
      ...(request.workerId === undefined ? {} : { workerId: request.workerId }),
    }
    this.calls.push(call)
    // In-memory log for assertions and the usage Surface; the JSONL file
    // below is the durable record, so a long-running daemon stays bounded.
    if (this.calls.length > MAX_CALL_LOG) this.calls.splice(0, this.calls.length - MAX_CALL_LOG)
    this.persist({ kind: 'call', ...call })
  }

  private currentUsage(): DailyUsage {
    const today = this.today()
    if (this.usageToday.date !== today) this.usageToday = this.restoreUsage(today)
    return this.usageToday
  }

  private restoreUsage(date: string): DailyUsage {
    const usage: DailyUsage = {
      date,
      tiers: { triage: 0, reasoning: 0 },
      workers: new Map(),
      capNotified: new Set(),
    }
    const path = this.usagePath(date)
    if (!path || !existsSync(path)) return usage
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const entry = parseUsageEntry(line)
      if (!entry) continue
      if (entry.kind === 'cap-notified') {
        usage.capNotified.add(entry.tier)
        continue
      }
      usage.tiers[entry.tier] += entry.usd
      if (entry.workerId) {
        usage.workers.set(entry.workerId, (usage.workers.get(entry.workerId) ?? 0) + entry.usd)
      }
    }
    // Past the cap at boot without a persisted notification (crash between
    // spend and notice): the user still has to hear about it.
    for (const tier of TIERS) {
      if (usage.tiers[tier] > this.config.dailyCapUsd[tier] && !usage.capNotified.has(tier)) {
        this.notifyCapExceeded(usage, tier)
      }
    }
    return usage
  }

  private persist(entry: Record<string, unknown>): void {
    const path = this.usagePath(this.today())
    if (!path) return
    mkdirSync(join(this.rootDir as string, 'usage'), { recursive: true })
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  }

  private usagePath(date: string): string | undefined {
    return this.rootDir ? join(this.rootDir, 'usage', `${date}.jsonl`) : undefined
  }

  private emit(event: RouterEvent): void {
    this.onEvent?.(event)
  }

  private nowIso(): string {
    return this.now().toISOString()
  }

  private today(): string {
    return this.nowIso().slice(0, 10)
  }
}

function defaultIsRetryable(error: unknown): boolean {
  if (error instanceof NonRetryableModelError) return false
  const status = statusOf(error)
  // 4xx (except 408/429) is our fault or the user's key — a retry elsewhere
  // cannot help. Everything else looks like a provider outage: fail over.
  if (status !== undefined && status >= 400 && status < 500) {
    return status === 408 || status === 429
  }
  return true
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const status = (error as Record<string, unknown>)['status']
  const statusCode = (error as Record<string, unknown>)['statusCode']
  if (typeof status === 'number') return status
  if (typeof statusCode === 'number') return statusCode
  return undefined
}

type UsageEntry =
  | { kind: 'spend'; tier: ModelTier; usd: number; workerId?: string }
  | { kind: 'cap-notified'; tier: ModelTier }

function parseUsageEntry(line: string): UsageEntry | undefined {
  try {
    const entry: unknown = JSON.parse(line)
    if (typeof entry !== 'object' || entry === null) return undefined
    const record = entry as Record<string, unknown>
    const tier = record['tier']
    if (tier !== 'triage' && tier !== 'reasoning') return undefined
    if (record['kind'] === 'cap-notified') return { kind: 'cap-notified', tier }
    if (record['kind'] !== 'spend') return undefined
    const usd = record['usd']
    // Same invariant as recordSpend: a corrupted or hand-edited log must
    // not lower the counters and silently reopen proactivity.
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) return undefined
    const workerId = typeof record['workerId'] === 'string' ? record['workerId'] : undefined
    return { kind: 'spend', tier, usd, ...(workerId === undefined ? {} : { workerId }) }
  } catch {
    return undefined
  }
}

/**
 * Keeps provider diagnostics out of durable logs: masks common API key
 * shapes and truncates. Full pattern redaction is the issue #15 vault work.
 */
function sanitizeErrorText(error: unknown): string {
  return errorText(error)
    .replace(/\bsk-[A-Za-z0-9_-]{4,}/g, 'sk-***')
    .replace(/\bbearer\s+\S+/gi, 'bearer ***')
    .slice(0, 300)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
