import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ModelRouter,
  ModelRoutingExhaustedError,
  NoAvailableModelError,
  NonRetryableModelError,
  RoutingConfigSchema,
  SpendingCapError,
  defaultRoutingConfig,
  loadRoutingConfig,
  saveRoutingConfig,
  tierForRequest,
  withMockFallback,
  type RouterEvent,
  type RoutingConfig,
  type SecretResolver,
} from './model-routing.ts'

const testConfig: RoutingConfig = {
  tiers: {
    reasoning: [
      { provider: 'mock', modelId: 'strong' },
      { provider: 'mock-fallback', modelId: 'strong-fallback' },
    ],
    triage: [
      { provider: 'mock', modelId: 'cheap' },
      { provider: 'mock-fallback', modelId: 'cheap-fallback' },
    ],
  },
  providerKeys: {},
  connectionKeys: {},
  dailyCapUsd: { triage: 1, reasoning: 5 },
}

function testRouter(overrides: Partial<ConstructorParameters<typeof ModelRouter>[0]> = {}) {
  return new ModelRouter({
    config: testConfig,
    now: () => new Date('2026-07-08T10:00:00.000Z'),
    sleep: async () => {},
    ...overrides,
  })
}

describe('usage map (tierForRequest)', () => {
  it('routes chat turns to reasoning and mechanical purposes to triage', () => {
    expect(tierForRequest({ purpose: 'chat-turn', origin: 'user' })).toBe('reasoning')
    for (const purpose of [
      'classification',
      'mechanical-update',
      'quarantined-reader',
      'heartbeat',
    ] as const) {
      expect(tierForRequest({ purpose, origin: 'proactive' })).toBe('triage')
    }
  })

  it('routes heartbeat-reasoning to reasoning while heartbeat stays triage', () => {
    expect(tierForRequest({ purpose: 'heartbeat-reasoning', origin: 'proactive' })).toBe(
      'reasoning',
    )
    expect(tierForRequest({ purpose: 'heartbeat', origin: 'proactive' })).toBe('triage')
  })

  it('requires Workers to declare their tier in the briefing', () => {
    expect(
      tierForRequest({
        purpose: 'worker',
        origin: 'proactive',
        workerId: 'wrk-1',
        workerTier: 'reasoning',
      }),
    ).toBe('reasoning')
    expect(() =>
      tierForRequest({ purpose: 'worker', origin: 'proactive', workerId: 'wrk-1' }),
    ).toThrow(/declare/i)
  })

  it('never lets a Worker route as user origin', () => {
    expect(() =>
      tierForRequest({
        purpose: 'worker',
        origin: 'user',
        workerId: 'wrk-1',
        workerTier: 'triage',
      }),
    ).toThrow(/proactive/i)
  })
})

describe('routing config', () => {
  it('ships defaults for Anthropic, OpenAI, and OpenRouter on both tiers', () => {
    const config = defaultRoutingConfig()
    for (const tier of ['triage', 'reasoning'] as const) {
      expect(config.tiers[tier].map((ref) => ref.provider)).toEqual([
        'anthropic',
        'openai',
        'openrouter',
      ])
    }
    expect(RoutingConfigSchema.parse(config)).toEqual(config)
  })

  it('rejects provider keys that are not secret:// references', () => {
    const raw = {
      ...defaultRoutingConfig(),
      providerKeys: { anthropic: 'sk-ant-plaintext-key' },
    }
    expect(RoutingConfigSchema.safeParse(raw).success).toBe(false)
  })

  it('merges user per-tier overrides from routing.json over the defaults', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-routing-'))
    const config = loadRoutingConfig(rootDir)
    expect(config).toEqual(defaultRoutingConfig())

    const overridden = loadRoutingConfigFromJson(rootDir, {
      tiers: {
        reasoning: [{ provider: 'openrouter', modelId: 'deepseek/deepseek-v4' }],
      },
      dailyCapUsd: { triage: 0.5 },
    })
    expect(overridden.tiers.reasoning).toEqual([
      { provider: 'openrouter', modelId: 'deepseek/deepseek-v4' },
    ])
    expect(overridden.tiers.triage).toEqual(defaultRoutingConfig().tiers.triage)
    expect(overridden.dailyCapUsd).toEqual({ triage: 0.5, reasoning: 20 })
  })

  it('merges partial providerKeys overrides instead of dropping the default key refs', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-routing-'))
    const config = loadRoutingConfigFromJson(rootDir, {
      providerKeys: { openrouter: 'secret://vault/openrouter' },
    })
    expect(config.providerKeys).toEqual({
      ...defaultRoutingConfig().providerKeys,
      openrouter: 'secret://vault/openrouter',
    })
  })

  it('reports a malformed routing.json with the file path instead of crashing opaquely', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-routing-'))
    writeFileSync(join(rootDir, 'routing.json'), '{not json')
    expect(() => loadRoutingConfig(rootDir)).toThrow(/routing config .*routing\.json/)
  })
})

describe('withMockFallback', () => {
  const noKeysResolve: SecretResolver = { resolve: () => undefined }

  it('appends the keyless mock candidate to both tiers when no key resolves, without mutating the input', () => {
    const config = defaultRoutingConfig()
    const original = structuredClone(config)

    const withFallback = withMockFallback(config, noKeysResolve)

    expect(withFallback.tiers.triage.at(-1)).toEqual({ provider: 'mock', modelId: 'reader-mock' })
    expect(withFallback.tiers.reasoning.at(-1)).toEqual({
      provider: 'mock',
      modelId: 'worker-mock',
    })
    expect(config).toEqual(original)
  })

  it('leaves a tier untouched once one of its providers has a resolvable key', () => {
    const config = defaultRoutingConfig()
    const onlyAnthropicResolves: SecretResolver = {
      resolve: (ref) => (ref === config.providerKeys['anthropic'] ? 'sk-real-key' : undefined),
    }

    const withFallback = withMockFallback(config, onlyAnthropicResolves)

    expect(withFallback.tiers.triage).toEqual(config.tiers.triage)
    expect(withFallback.tiers.reasoning).toEqual(config.tiers.reasoning)
  })

  it('treats a keyless provider entry (no providerKeys entry) as already available', () => {
    const config: RoutingConfig = {
      tiers: {
        triage: [{ provider: 'local', modelId: 'triage-local' }],
        reasoning: [{ provider: 'local', modelId: 'reasoning-local' }],
      },
      providerKeys: {},
      connectionKeys: {},
      dailyCapUsd: { triage: 1, reasoning: 5 },
    }

    const withFallback = withMockFallback(config, noKeysResolve)

    expect(withFallback.tiers.triage).toEqual(config.tiers.triage)
    expect(withFallback.tiers.reasoning).toEqual(config.tiers.reasoning)
  })
})

describe('saveRoutingConfig', () => {
  it('round-trips tiers, providerKeys and caps through save then load', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-routing-'))
    // Every default provider key is present so `loadRoutingConfig`'s
    // defaults-merge is a no-op — this isolates the round-trip assertion
    // to what `saveRoutingConfig`/`writeJsonAtomic` actually persisted.
    const config: RoutingConfig = {
      tiers: {
        reasoning: [{ provider: 'anthropic', modelId: 'claude-sonnet-5' }],
        triage: [{ provider: 'anthropic', modelId: 'claude-haiku-4-5' }],
      },
      providerKeys: {
        anthropic: 'secret://vault/anthropic',
        openai: 'secret://vault/openai',
        openrouter: 'secret://vault/openrouter',
      },
      connectionKeys: {},
      dailyCapUsd: { triage: 2, reasoning: 10 },
    }

    saveRoutingConfig(rootDir, config)

    expect(loadRoutingConfig(rootDir)).toEqual(config)

    const raw = JSON.parse(readFileSync(join(rootDir, 'routing.json'), 'utf8')) as unknown
    expect(raw).toEqual(config)
  })

  it('creates a .bak file when overwriting an existing routing.json', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-routing-'))
    saveRoutingConfig(rootDir, defaultRoutingConfig())
    saveRoutingConfig(rootDir, {
      ...defaultRoutingConfig(),
      dailyCapUsd: { triage: 1, reasoning: 1 },
    })

    const backups = readdirSync(rootDir).filter((entry) => entry.startsWith('routing.json.bak-'))
    expect(backups).toHaveLength(1)
  })

  it('writes a file that parses cleanly against the strict schema', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-routing-'))
    const config = defaultRoutingConfig()
    saveRoutingConfig(rootDir, config)

    const raw = JSON.parse(readFileSync(join(rootDir, 'routing.json'), 'utf8')) as unknown
    expect(RoutingConfigSchema.parse(raw)).toEqual(config)
  })
})

describe('route', () => {
  it('serves a chat turn and a triage round with different models (call log assert)', async () => {
    const router = testRouter()
    await router.execute({ purpose: 'chat-turn', origin: 'user' }, async () => 'chat ok')
    await router.execute(
      { purpose: 'classification', origin: 'proactive' },
      async () => 'triage ok',
    )

    const [chatCall, triageCall] = router.callLog()
    expect(chatCall?.model).toEqual({ provider: 'mock', modelId: 'strong', tier: 'reasoning' })
    expect(triageCall?.model).toEqual({ provider: 'mock', modelId: 'cheap', tier: 'triage' })
    expect(chatCall?.model.modelId).not.toBe(triageCall?.model.modelId)
  })

  it('skips providers whose BYOK secret does not resolve', () => {
    const router = testRouter({
      config: { ...testConfig, providerKeys: { mock: 'secret://env/VEDUTA_TEST_MISSING_KEY' } },
    })
    expect(router.route({ purpose: 'chat-turn', origin: 'user' })).toEqual({
      provider: 'mock-fallback',
      modelId: 'strong-fallback',
      tier: 'reasoning',
    })
  })

  it('fails clearly when every configured provider is missing its secret', () => {
    const router = testRouter({
      config: {
        ...testConfig,
        providerKeys: {
          mock: 'secret://env/VEDUTA_TEST_MISSING_KEY',
          'mock-fallback': 'secret://env/VEDUTA_TEST_MISSING_KEY_2',
        },
      },
    })
    expect(() => router.route({ purpose: 'chat-turn', origin: 'user' })).toThrow(
      NoAvailableModelError,
    )
  })
})

describe('failover', () => {
  it('continues the conversation on the fallback when the primary provider is down', async () => {
    const events: RouterEvent[] = []
    const slept: number[] = []
    const router = testRouter({
      onEvent: (event) => events.push(event),
      sleep: async (ms) => {
        slept.push(ms)
      },
    })

    const result = await router.execute({ purpose: 'chat-turn', origin: 'user' }, async (model) => {
      if (model.provider === 'mock') throw new Error('connect ETIMEDOUT')
      return `answered by ${model.modelId}`
    })

    expect(result).toBe('answered by strong-fallback')
    expect(router.callLog().map((call) => [call.model.provider, call.outcome])).toEqual([
      ['mock', 'error'],
      ['mock-fallback', 'ok'],
    ])
    expect(events.filter((event) => event.type === 'model.failover')).toHaveLength(1)
    expect(slept).toEqual([250])
  })

  it('makes one ordered pass and reports exhaustion with the last error as cause', async () => {
    const attempts: string[] = []
    const router = testRouter()
    await expect(
      router.execute({ purpose: 'chat-turn', origin: 'user' }, async (model) => {
        attempts.push(model.provider)
        throw new Error(`down: ${model.provider}`)
      }),
    ).rejects.toThrow(ModelRoutingExhaustedError)
    expect(attempts).toEqual(['mock', 'mock-fallback'])
  })

  it('does not fail over on non-retryable errors', async () => {
    const attempts: string[] = []
    const router = testRouter()
    await expect(
      router.execute({ purpose: 'chat-turn', origin: 'user' }, async (model) => {
        attempts.push(model.provider)
        throw new NonRetryableModelError('invalid API key')
      }),
    ).rejects.toThrow(/invalid API key/)
    expect(attempts).toEqual(['mock'])
  })

  it('redacts key-shaped fragments from persisted call errors and failover reasons', async () => {
    const events: RouterEvent[] = []
    const router = testRouter({ onEvent: (event) => events.push(event) })

    await router.execute({ purpose: 'chat-turn', origin: 'user' }, async (model) => {
      if (model.provider === 'mock') throw new Error('401 for key sk-ant-veduta-1234567890')
      return 'ok'
    })

    const failed = router.callLog()[0]
    expect(failed?.errorMessage).toContain('sk-***')
    expect(failed?.errorMessage).not.toContain('sk-ant-veduta-1234567890')
    const failover = events.find((event) => event.type === 'model.failover')
    expect(failover && 'reason' in failover ? failover.reason : '').toContain('sk-***')
  })

  it('treats provider HTTP client errors as non-retryable', async () => {
    const attempts: string[] = []
    const router = testRouter()
    const badRequest = Object.assign(new Error('bad request'), { status: 400 })
    await expect(
      router.execute({ purpose: 'chat-turn', origin: 'user' }, async (model) => {
        attempts.push(model.provider)
        throw badRequest
      }),
    ).rejects.toThrow('bad request')
    expect(attempts).toEqual(['mock'])
  })
})

describe('spending caps', () => {
  it('shuts off proactivity past the daily cap while the synchronous path stays active', async () => {
    const notifications: RouterEvent[] = []
    const router = testRouter({
      onEvent: (event) => {
        if (event.type === 'spending.cap-exceeded') notifications.push(event)
      },
    })

    router.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, 1.5)

    expect(router.proactivityAllowed('triage')).toBe(false)
    expect(notifications).toHaveLength(1)
    await expect(
      router.execute({ purpose: 'heartbeat', origin: 'proactive' }, async () => 'never'),
    ).rejects.toThrow(SpendingCapError)
    await expect(
      router.execute({ purpose: 'chat-turn', origin: 'user' }, async () => 'still here'),
    ).resolves.toBe('still here')
  })

  it('notifies exactly once per tier per day', () => {
    let notified = 0
    const router = testRouter({
      onEvent: (event) => {
        if (event.type === 'spending.cap-exceeded') notified += 1
      },
    })
    router.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, 1.5)
    router.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, 0.5)
    expect(notified).toBe(1)
  })

  it('tracks spend per Worker', () => {
    const router = testRouter()
    router.recordSpend({ provider: 'mock', modelId: 'strong', tier: 'reasoning' }, 0.5, {
      workerId: 'wrk-research',
    })
    router.recordSpend({ provider: 'mock', modelId: 'strong', tier: 'reasoning' }, 0.25, {
      workerId: 'wrk-research',
    })
    expect(router.usage().workers).toEqual([{ workerId: 'wrk-research', spentUsd: 0.75 }])
  })

  it('ignores non-finite and negative spend as unreported', () => {
    const router = testRouter()
    router.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, Number.NaN)
    router.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, -1)
    expect(router.usage().tiers.triage.spentUsd).toBe(0)
  })

  it('persists spend to the usage log and rebuilds counters on restart', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-usage-'))
    const now = () => new Date('2026-07-08T10:00:00.000Z')
    const first = testRouter({ rootDir, now })
    first.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, 0.75)

    const logged = readFileSync(join(rootDir, 'usage', '2026-07-08.jsonl'), 'utf8')
    expect(logged).toContain('"spend"')

    let notified = 0
    const restarted = testRouter({
      rootDir,
      now,
      onEvent: (event) => {
        if (event.type === 'spending.cap-exceeded') notified += 1
      },
    })
    expect(restarted.usage().tiers.triage.spentUsd).toBe(0.75)
    restarted.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, 0.5)
    expect(restarted.proactivityAllowed('triage')).toBe(false)
    expect(notified).toBe(1)
  })

  it('re-notifies at boot when the daemon crashed between spend and notice', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-usage-'))
    const usageDir = join(rootDir, 'usage')
    mkdirSync(usageDir, { recursive: true })
    // Over-cap spend persisted, but no cap-notified marker: the crash window.
    writeFileSync(
      join(usageDir, '2026-07-08.jsonl'),
      `${JSON.stringify({ kind: 'spend', tier: 'triage', usd: 1.5 })}\n`,
    )

    let notified = 0
    const onEvent = (event: RouterEvent) => {
      if (event.type === 'spending.cap-exceeded') notified += 1
    }
    testRouter({ rootDir, onEvent })
    expect(notified).toBe(1)

    testRouter({ rootDir, onEvent })
    expect(notified).toBe(1)
  })

  it('ignores negative spend entries from a corrupted usage log', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-usage-'))
    const usageDir = join(rootDir, 'usage')
    mkdirSync(usageDir, { recursive: true })
    writeFileSync(
      join(usageDir, '2026-07-08.jsonl'),
      [
        JSON.stringify({ kind: 'spend', tier: 'triage', usd: 0.5 }),
        JSON.stringify({ kind: 'spend', tier: 'triage', usd: -100 }),
      ].join('\n'),
    )
    const router = testRouter({ rootDir })
    expect(router.usage().tiers.triage.spentUsd).toBe(0.5)
  })

  it('bounds the in-memory call log for a long-running daemon', async () => {
    const router = testRouter()
    for (let index = 0; index < 520; index += 1) {
      await router.execute({ purpose: 'chat-turn', origin: 'user' }, async () => 'ok')
    }
    expect(router.callLog()).toHaveLength(500)
  })

  it('resets counters on the next day', () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-usage-'))
    let today = new Date('2026-07-08T23:00:00.000Z')
    const router = testRouter({ rootDir, now: () => today })
    router.recordSpend({ provider: 'mock', modelId: 'cheap', tier: 'triage' }, 1.5)
    expect(router.proactivityAllowed('triage')).toBe(false)

    today = new Date('2026-07-09T01:00:00.000Z')
    expect(router.proactivityAllowed('triage')).toBe(true)
    expect(router.usage().tiers.triage.spentUsd).toBe(0)
  })
})

describe('usage snapshot', () => {
  it('reports spend against caps per tier', () => {
    const router = testRouter()
    router.recordSpend({ provider: 'mock', modelId: 'strong', tier: 'reasoning' }, 2)
    const usage = router.usage()
    expect(usage.date).toBe('2026-07-08')
    expect(usage.tiers.reasoning).toEqual({ spentUsd: 2, capUsd: 5 })
    expect(usage.tiers.triage).toEqual({ spentUsd: 0, capUsd: 1 })
  })
})

function loadRoutingConfigFromJson(rootDir: string, overrides: unknown): RoutingConfig {
  writeFileSync(join(rootDir, 'routing.json'), JSON.stringify(overrides))
  return loadRoutingConfig(rootDir)
}
