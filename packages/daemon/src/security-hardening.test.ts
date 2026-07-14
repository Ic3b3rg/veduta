import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressDeniedError, EgressPolicy, installEgressEnforcement } from './egress.ts'
import { envSecretResolver, ModelRouter } from './model-routing.ts'
import { defaultRedactor, installConsoleRedaction } from './redaction.ts'
import { assembleEgressPolicy } from './server.ts'
import { compositeSecretResolver } from './secrets-vault.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { TrustStore } from './trust-store.ts'

/**
 * Integration acceptance tests for issue #15 (egress allowlist, secret
 * redaction end-to-end): AC1 asserts a denied host is actually blocked and
 * logged host-only; AC2 plants a fake secret through the same seams a real
 * one would take (resolution, an event, an error path, an audit row,
 * console output) and then sweeps the entire durable rootDir — every text
 * file and every SQLite row — asserting the plaintext value never survives.
 */

const cleanupDirs: string[] = []

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanupDirs.push(dir)
  return dir
}

describe('AC1 — egress: blocked host is denied, logged host-only, and unreachable end-to-end', () => {
  it('assembleEgressPolicy allows a configured provider, denies an undeclared host, and the denial log carries the host but never the path', () => {
    const rootDir = freshRoot('veduta-egress-policy-')
    const denialLogPath = join(rootDir, 'egress-denials.jsonl')
    const policy = assembleEgressPolicy({
      rootDir,
      providers: ['anthropic'],
      toolDomains: [],
    })
    policy.onDenial((denial) => {
      appendFileSync(denialLogPath, `${JSON.stringify(denial)}\n`)
    })

    expect(() => policy.check('https://api.anthropic.com/v1/x')).not.toThrow()
    expect(() => policy.check('https://evil.example/steal')).toThrow(EgressDeniedError)

    const logged = readFileSync(denialLogPath, 'utf8')
    expect(logged).toContain('evil.example')
    expect(logged).not.toContain('/steal')
  })

  describe('installEgressEnforcement (global dispatcher)', () => {
    let savedDispatcher: ReturnType<typeof getGlobalDispatcher>

    afterEach(() => {
      // Never leak an installed policy past this suite — other test files
      // in the same worker share undici's global dispatcher.
      setGlobalDispatcher(savedDispatcher)
    })

    it('rejects fetch() to an undeclared host once enforcement is installed', async () => {
      savedDispatcher = getGlobalDispatcher()
      const policy = new EgressPolicy({ allowLoopback: true })
      installEgressEnforcement(policy)

      await expect(fetch('https://blocked.example/')).rejects.toThrow()
    })
  })
})

describe('AC2 — no plaintext secret survives in any durable rootDir artifact', () => {
  it('sweeps every text file and every sqlite row under rootDir after the secret passed through every durable sink', async () => {
    const FAKE_KEY = 'sk-ant-FAKEKEY0015TESTdeadbeef'
    const envName = 'VEDUTA_TEST_AC2_FAKE_KEY'
    process.env[envName] = FAKE_KEY
    try {
      // Plant + register: mirrors how the daemon's secret resolver wraps
      // `compositeSecretResolver` so every successful resolution registers
      // the value with the shared redactor (issue #15 D2/D3, server.ts's
      // `buildSecretResolver`).
      const composite = compositeSecretResolver(envSecretResolver)
      const resolved = composite.resolve(`secret://env/${envName}`)
      expect(resolved).toBe(FAKE_KEY)
      defaultRedactor.register(resolved as string)

      const rootDir = freshRoot('veduta-ac2-sweep-')

      // 1. Event log: the key reaches both `text` and `payload`.
      const spacesEngine = new SpacesEngine({ rootDir })
      const space = spacesEngine.createSpace({ name: 'AC2 sweep' })
      spacesEngine.appendEvent(space.id, {
        text: `leaked ${FAKE_KEY} in event text`,
        payload: { token: FAKE_KEY },
      })

      // 2. A router failure path that echoes the key into the persisted
      // call log (`sanitizeErrorText` -> `<rootDir>/usage/<date>.jsonl`).
      const router = new ModelRouter({
        rootDir,
        config: {
          tiers: {
            triage: [{ provider: 'anthropic', modelId: 'test-model' }],
            reasoning: [{ provider: 'anthropic', modelId: 'test-model' }],
          },
          providerKeys: {},
          dailyCapUsd: { triage: 5, reasoning: 20 },
        },
      })
      await expect(
        router.execute({ purpose: 'classification', origin: 'user' }, () => {
          throw new Error(`provider rejected key ${FAKE_KEY}`)
        }),
      ).rejects.toThrow()

      // 3. A trust audit write embedding the key in both `input` and `detail`.
      const trustStore = new TrustStore(rootDir)
      trustStore.insertAudit(
        {
          kind: 'action.decision',
          toolName: 'send_message',
          decision: 'deny',
          detail: `blocked with key ${FAKE_KEY}`,
          input: { token: FAKE_KEY },
        },
        new Date().toISOString(),
      )
      trustStore.dispose()

      // 4. console.error with the key — must reach the underlying stream redacted.
      installConsoleRedaction()
      console.error(`leak ${FAKE_KEY}`)

      const offenders = sweepForPlaintext(rootDir, FAKE_KEY)
      expect(offenders).toEqual([])
    } finally {
      delete process.env[envName]
    }
  })
})

/** Recursively lists every regular file under `dir`. */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/**
 * Every file under `rootDir` that still contains `needle`: `.sqlite` files
 * are opened and every table's every row is dumped and stringified; every
 * other file is read as raw text. Returns an empty array when clean.
 */
function sweepForPlaintext(rootDir: string, needle: string): string[] {
  const offenders: string[] = []
  for (const filePath of walk(rootDir)) {
    if (!statSync(filePath).isFile()) continue
    if (filePath.endsWith('.sqlite')) {
      offenders.push(...sweepSqliteFile(filePath, needle))
      continue
    }
    const raw = readFileSync(filePath, 'utf8')
    if (raw.includes(needle)) offenders.push(filePath)
  }
  return offenders
}

function sweepSqliteFile(filePath: string, needle: string): string[] {
  const offenders: string[] = []
  const db = new DatabaseSync(filePath)
  try {
    const tables = db
      .prepare(`select name from sqlite_master where type = 'table'`)
      .all()
      .map((row) => String((row as Record<string, unknown>)['name']))
    for (const table of tables) {
      const rows = db.prepare(`select * from "${table}"`).all()
      for (const row of rows) {
        if (JSON.stringify(row).includes(needle)) offenders.push(`${filePath}#${table}`)
      }
    }
  } finally {
    db.close()
  }
  return offenders
}
