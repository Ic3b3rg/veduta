import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  SYSTEM_SPACE_ID,
  type ImportItem,
  type ImportOptions,
  type ImportPlan,
} from '@veduta/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreBackup } from './backup.ts'
import {
  ImportRefusedError,
  applyImport,
  ownershipTarget,
  requirePlanItem,
} from './import-apply.ts'
import { planLegacyImport } from './import-plan.ts'
import { IMPORTED_SPACE_SLUG, adaptSoul } from './import-mapping.ts'
import { scanLegacySecrets, type SecretScan } from './import-secrets.ts'
import { readLegacySource, type LegacySourceSnapshot } from './import-source.ts'
import { findImport, loadImportState } from './import-state.ts'
import { BYOK_ADAPTERS } from './model-connection-byok.ts'
import { ModelConnectionRegistry } from './model-connection-registry.ts'
import { envSecretResolver } from './model-routing.ts'
import { SecretsVault } from './secrets-vault.ts'
import { SpacesEngine } from './spaces-engine.ts'

const KEY_MATERIAL = Buffer.from('a test vault key, long enough for scrypt derivation')

/**
 * shaped so that NO built-in redaction pattern (`sk-…`/`Bearer …`/
 * `AKIA…`, see `redaction.ts`) matches it — the "no secret anywhere" sweeps
 * below must depend on `import-secrets.ts` actually registering this value
 * via `scanLegacySecrets`, not pass by accident because a built-in shape
 * also happens to catch it. The old fixture secret (`sk-ant-FIXTURESECRET-9`)
 * proved nothing: the sweeps would have passed even if registration had
 * never run, since the built-in `sk-ant-…` pattern alone would have caught it.
 */
const FIXTURE_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
/** Kept alongside so this suite still exercises the built-in-pattern path too. */
const BUILT_IN_PATTERN_SECRET = 'sk-ant-FIXTURESECRET-9'

let tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** Sorted recursive listing of relative file paths, for before/after "nothing written" comparisons. */
function listRecursive(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
      } else {
        out.push(relative(root, abs))
      }
    }
  }
  walk(root)
  return out.sort()
}

/** Absolute paths of every regular file under `root`, for the secret-sweep tests. */
function listAllFiles(root: string): string[] {
  return listRecursive(root).map((relPath) => join(root, relPath))
}

/**
 * A realistic `~/.hermes` install ("Source layouts" table): SOUL.md, a real-shaped USER.md profile,
 * `§`-separated MEMORY.md entries, a dated daily note, a `.env` with two importable provider keys
 * (one of each fixture-secret shape), and archived material (`config.yaml`, `skills/`).
 */
function buildHermesFixture(): string {
  const dir = freshDir('veduta-hermes-src-')
  writeFileSync(
    join(dir, 'SOUL.md'),
    'You are Hermes, calm and thorough. Hermes never rushes a user through a decision.\n',
  )
  mkdirSync(join(dir, 'memories'), { recursive: true })
  writeFileSync(
    join(dir, 'memories', 'USER.md'),
    [
      'Name: Priya Sharma',
      'Role: Product manager at a fintech startup',
      'Timezone: Europe/Lisbon',
      'Likes: quiet mornings, filter coffee, long-distance running',
      'Family: married to Tom, one daughter (Mira, age 6)',
      'Health: manages mild asthma, sees Dr. Ochoa twice a year',
    ].join('\n'),
  )
  writeFileSync(
    join(dir, 'memories', 'MEMORY.md'),
    [
      'Priya prefers async updates over meetings.',
      'The team ships on Thursdays.',
      'Mira has a piano recital on the 14th of every month.',
    ].join('\n§\n'),
  )
  writeFileSync(
    join(dir, 'memories', '2026-01-05.md'),
    'Talked through Q1 roadmap risks with Priya.',
  )
  writeFileSync(
    join(dir, '.env'),
    `ANTHROPIC_API_KEY=${FIXTURE_SECRET}\nOPENAI_API_KEY=${BUILT_IN_PATTERN_SECRET}\n`,
  )
  writeFileSync(join(dir, 'config.yaml'), 'model: hermes-large\ncompression: true\n')
  mkdirSync(join(dir, 'skills'), { recursive: true })
  writeFileSync(join(dir, 'skills', 'weather.md'), '# Weather skill\nChecks forecast.com.\n')
  return dir
}

interface FixtureRead {
  snapshot: LegacySourceSnapshot
  secrets: SecretScan
}

function readHermesFixture(sourceDir: string): FixtureRead {
  return {
    snapshot: readLegacySource(sourceDir, 'hermes'),
    secrets: scanLegacySecrets({ kind: 'hermes', dir: sourceDir }),
  }
}

/**
 * Builds the plan the same way a preview call site would (`planLegacyImport` is the exact
 * composition `applyImportLocked` also runs, now inside its lock) — used here only for pre-apply
 * assertions on the plan's shape; `applyImport` itself always recomputes its own.
 */
function buildPlanFor(rootDir: string, read: FixtureRead, options: ImportOptions): ImportPlan {
  return planLegacyImport({
    rootDir,
    snapshot: read.snapshot,
    secrets: read.secrets,
    options,
    backupAvailable: true,
  })
}

describe('applyImport — AC1 (issue 020): a real ~/.hermes import', () => {
  it('populates FACTS, adapts SOUL, imports zero secrets without --secrets, and leaves a restorable backup', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    // A realistic target already went through onboarding (issue #19) before
    // ever running the importer: `spaces/`, default SOUL.md/USER.md already
    // exist. This matters for the backup assertion below — apply's backup
    // (step 3) runs BEFORE any of apply's own writes (ordering),
    // so backing up a truly empty, never-initialized rootDir would have
    // nothing for `restoreBackup`'s sanity check to find.
    new SpacesEngine({ rootDir })
    const read = readHermesFixture(sourceDir)

    const result = await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    expect(result.soulUpdated).toBe(true)
    expect(result.facts.added).toBeGreaterThan(0)
    expect(result.secretsImported).toEqual([])

    const factsContent = readFileSync(
      join(rootDir, 'spaces', IMPORTED_SPACE_SLUG, 'FACTS.md'),
      'utf8',
    )
    expect(factsContent).toContain('async updates')

    const soulContent = readFileSync(join(rootDir, 'SOUL.md'), 'utf8')
    expect(soulContent).toBe(adaptSoul(read.snapshot.soul!.text, 'hermes'))
    // Anti-divergence guarantee: what the
    // plan previewed in `soulPreview` must be byte-identical to what actually
    // landed on disk — the mitigation is worthless if the two can drift.
    expect(result.plan.soulPreview).toBeDefined()
    expect(soulContent).toBe(result.plan.soulPreview)

    // Zero secrets migrated without --secrets.
    expect(existsSync(join(rootDir, 'secrets.vault'))).toBe(false)

    // Restorable backup.
    const backupDir = join(rootDir, 'backups')
    const backupFiles = readdirSync(backupDir)
    expect(backupFiles).toHaveLength(1)
    const restoreDir = freshDir('veduta-restore-')
    await restoreBackup({
      file: join(backupDir, backupFiles[0]!),
      targetRootDir: restoreDir,
      keyMaterial: KEY_MATERIAL,
    })
    expect(existsSync(join(restoreDir, 'spaces'))).toBe(true)
  })
})

describe('applyImport — AC2 (issue 020): re-import refusal', () => {
  it('a second apply without --overwrite throws ImportRefusedError naming the previous import and its date', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)
    await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    const priorEntry = findImport(loadImportState(rootDir), 'hermes')
    expect(priorEntry).toBeDefined()

    const read2 = readHermesFixture(sourceDir)
    const plan2 = buildPlanFor(rootDir, read2, { overwrite: false, secrets: false })
    expect(plan2.blocked.length).toBeGreaterThan(0)

    const before = listRecursive(rootDir)
    let caught: unknown
    try {
      await applyImport(
        { rootDir, keyMaterial: KEY_MATERIAL },
        {
          snapshot: read2.snapshot,
          secrets: read2.secrets,
          options: { overwrite: false, secrets: false },
        },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ImportRefusedError)
    const refusal = caught as ImportRefusedError
    expect(refusal.message).toContain('already imported')
    expect(refusal.message).toContain(priorEntry!.at)
    expect(listRecursive(rootDir)).toEqual(before)
  })

  it('two concurrent-looking applies of the same source cannot both see "not previously imported" — the second always recomputes the plan inside the lock', async () => {
    // Simulates the race the in-lock replan closes: two callers each read the source and
    // build their own view of the world (as a preview would) before either
    // one applies. Under the old code (a pre-built plan trusted at apply
    // time) both could believe the source was never imported. Now apply
    // recomputes the plan itself, inside the lock, so the second one refuses.
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const readA = readHermesFixture(sourceDir)
    const readB = readHermesFixture(sourceDir)

    await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: readA.snapshot,
        secrets: readA.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    await expect(
      applyImport(
        { rootDir, keyMaterial: KEY_MATERIAL },
        {
          snapshot: readB.snapshot,
          secrets: readB.secrets,
          options: { overwrite: false, secrets: false },
        },
      ),
    ).rejects.toThrow(ImportRefusedError)
  })
})

describe('applyImport — the lock', () => {
  it('refuses when import.lock is already held, and writes nothing', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    writeFileSync(join(rootDir, 'import.lock'), '')
    const read = readHermesFixture(sourceDir)

    const before = listRecursive(rootDir)
    await expect(
      applyImport(
        { rootDir, keyMaterial: KEY_MATERIAL },
        {
          snapshot: read.snapshot,
          secrets: read.secrets,
          options: { overwrite: false, secrets: false },
        },
      ),
    ).rejects.toThrow(ImportRefusedError)
    expect(listRecursive(rootDir)).toEqual(before)
  })

  it('releases the lock after a refusal, so a following apply can proceed', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)

    // No `keyMaterial` in deps: `planLegacyImport` (recomputed inside the
    // lock) sees `backupAvailable: false` and blocks naturally — no need
    // to hand-construct a blocked plan, which is no longer possible since
    // `applyImport` does not accept a pre-built plan at all.
    await expect(
      applyImport(
        { rootDir },
        {
          snapshot: read.snapshot,
          secrets: read.secrets,
          options: { overwrite: false, secrets: false },
        },
      ),
    ).rejects.toThrow(ImportRefusedError)
    expect(existsSync(join(rootDir, 'import.lock'))).toBe(false)

    await expect(
      applyImport(
        { rootDir, keyMaterial: KEY_MATERIAL },
        {
          snapshot: read.snapshot,
          secrets: read.secrets,
          options: { overwrite: false, secrets: false },
        },
      ),
    ).resolves.toBeDefined()
  })
})

describe('applyImport — no secret anywhere', () => {
  it('without --secrets: no durable file under rootDir contains either fixture secret', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)

    await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    for (const file of listAllFiles(rootDir)) {
      const content = readFileSync(file, 'utf8')
      expect(content).not.toContain(FIXTURE_SECRET)
      expect(content).not.toContain(BUILT_IN_PATTERN_SECRET)
    }
  })

  it('with --secrets: every file except secrets.vault is free of either fixture secret', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const vault = SecretsVault.open(rootDir, KEY_MATERIAL)
    const read = readHermesFixture(sourceDir)

    const result = await applyImport(
      { rootDir, vault, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: true },
      },
    )

    expect(result.secretsImported.sort()).toEqual(['anthropic', 'openai'].sort())
    expect(vault.resolve('secret://vault/anthropic')).toBe(FIXTURE_SECRET)
    expect(vault.resolve('secret://vault/openai')).toBe(BUILT_IN_PATTERN_SECRET)

    const vaultFile = join(rootDir, 'secrets.vault')
    for (const file of listAllFiles(rootDir)) {
      if (file === vaultFile) continue
      const content = readFileSync(file, 'utf8')
      expect(content).not.toContain(FIXTURE_SECRET)
      expect(content).not.toContain(BUILT_IN_PATTERN_SECRET)
    }
  })

  it('refuses --secrets when no vault is available, before writing anything', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)

    const before = listRecursive(rootDir)
    await expect(
      applyImport(
        { rootDir, keyMaterial: KEY_MATERIAL },
        {
          snapshot: read.snapshot,
          secrets: read.secrets,
          options: { overwrite: false, secrets: true },
        },
      ),
    ).rejects.toThrow(ImportRefusedError)
    expect(listRecursive(rootDir)).toEqual(before)
  })

  it('refuses when no vault key material is available for the backup', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)

    await expect(
      applyImport(
        { rootDir },
        {
          snapshot: read.snapshot,
          secrets: read.secrets,
          options: { overwrite: false, secrets: false },
        },
      ),
    ).rejects.toThrow(ImportRefusedError)
  })
})

describe('applyImport — Model connection reconciliation (issue #47)', () => {
  it('reconciles an imported anthropic key into a visible connection inside the same apply', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const vault = SecretsVault.open(rootDir, KEY_MATERIAL)
    const read = readHermesFixture(sourceDir)

    // The real registry, not a recording fake: proves the imported key ends
    // up as an actual `connected` connection record, not just that some
    // callback fired with the right arguments.
    const registry = new ModelConnectionRegistry({
      rootDir,
      adapters: BYOK_ADAPTERS,
      vault,
      secrets: envSecretResolver,
      profile: 'loopback',
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => new Date('2026-08-09T10:00:00.000Z'),
      probe: async () => {},
      isRoutableModel: () => true,
      env: {},
    })

    await applyImport(
      {
        rootDir,
        vault,
        keyMaterial: KEY_MATERIAL,
        connections: {
          reconcileImportedByokKeys: (names) => registry.reconcileImportedKeys(names),
        },
      },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: true },
      },
    )

    const snapshot = await registry.snapshot()
    const anthropic = snapshot.connections.find((connection) => connection.id === 'anthropic')
    expect(anthropic?.state).toBe('connected')
    const openai = snapshot.connections.find((connection) => connection.id === 'openai')
    expect(openai?.state).toBe('connected')
  })
})

describe('applyImport — a credential-looking value found in .env is also redacted out of MEMORY.md-derived FACTS', () => {
  it('registers a not-importable bot-token-shaped value and redacts the same string out of FACTS', async () => {
    // A Telegram-bot-token shape: recorded by name in `.env` (never
    // importable — no home for it in `routing.json`), but the SAME string
    // also appears in MEMORY.md prose, exactly the accident registration protects
    // against. Deliberately not `sk-…`/`Bearer …`/`AKIA…`-shaped, so it is
    // only caught if `import-secrets.ts` actually registers it.
    const BOT_TOKEN = '123456789:AAHhermesBotTokenSharedWithMemory'
    const sourceDir = freshDir('veduta-hermes-a9-src-')
    mkdirSync(join(sourceDir, 'memories'), { recursive: true })
    writeFileSync(join(sourceDir, 'SOUL.md'), 'You are Hermes.\n')
    writeFileSync(
      join(sourceDir, 'memories', 'MEMORY.md'),
      `The Telegram bot token is ${BOT_TOKEN}, keep it safe.`,
    )
    writeFileSync(join(sourceDir, '.env'), `TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`)

    const rootDir = freshDir('veduta-apply-a9-target-')
    const read = readHermesFixture(sourceDir)
    expect(read.secrets.importable).toEqual([])
    expect(read.secrets.notImportable.some((n) => n.sourceKey === 'TELEGRAM_BOT_TOKEN')).toBe(true)

    await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    const factsContent = readFileSync(
      join(rootDir, 'spaces', IMPORTED_SPACE_SLUG, 'FACTS.md'),
      'utf8',
    )
    expect(factsContent).not.toContain(BOT_TOKEN)
    expect(factsContent).toContain('[redacted]')
  })
})

describe('applyImport — taint', () => {
  it('every imported fact and event carries untrusted:hermes, visible in the raw files', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)
    await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    const factsContent = readFileSync(
      join(rootDir, 'spaces', IMPORTED_SPACE_SLUG, 'FACTS.md'),
      'utf8',
    )
    expect(factsContent).toContain('origin: untrusted:hermes')

    const logDir = join(rootDir, 'spaces', IMPORTED_SPACE_SLUG, 'log')
    let sawUntrustedNote = false
    for (const file of readdirSync(logDir)) {
      const lines = readFileSync(join(logDir, file), 'utf8').split('\n').filter(Boolean)
      for (const line of lines) {
        const event: { type: string; origin: string } = JSON.parse(line)
        if (event.type === 'import.note' || event.type === 'import.memory') {
          expect(event.origin).toBe('untrusted:hermes')
          sawUntrustedNote = true
        }
      }
    }
    expect(sawUntrustedNote).toBe(true)
  })
})

describe('applyImport — note dates', () => {
  it('a 2026-01-05.md note lands in the 2026-01-05.jsonl Event log file', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)
    await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    const logPath = join(rootDir, 'spaces', IMPORTED_SPACE_SLUG, 'log', '2026-01-05.jsonl')
    expect(existsSync(logPath)).toBe(true)
    expect(readFileSync(logPath, 'utf8')).toContain('Q1 roadmap')
  })
})

describe('applyImport — slug reconciliation', () => {
  it('never reuses the canonical System Space when its presentation slug is imported', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const seededEngine = new SpacesEngine({
      rootDir,
      seed: {
        spaces: [
          {
            id: SYSTEM_SPACE_ID,
            name: 'Controls',
            slug: IMPORTED_SPACE_SLUG,
            archived: false,
          },
        ],
        surfaces: [],
      },
    })
    const systemEvents = seededEngine.readRecent(SYSTEM_SPACE_ID, Number.MAX_SAFE_INTEGER)
    const read = readHermesFixture(sourceDir)

    const result = await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read.snapshot,
        secrets: read.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    const reopened = new SpacesEngine({ rootDir })
    if (!result.spaceId) throw new Error('expected an imported Space')
    expect(result.spaceId).not.toBe(SYSTEM_SPACE_ID)
    expect(reopened.getSpace(result.spaceId)).toMatchObject({
      id: 'spc-imported-2',
      slug: 'imported-2',
    })
    expect(reopened.getSpace(SYSTEM_SPACE_ID)).toMatchObject({
      name: 'Controls',
      slug: IMPORTED_SPACE_SLUG,
      archived: false,
    })
    expect(reopened.readFacts(SYSTEM_SPACE_ID).active).toEqual([])
    expect(reopened.readRecent(SYSTEM_SPACE_ID, Number.MAX_SAFE_INTEGER)).toEqual(systemEvents)
  })

  it('reuses the imported Space by slug on a second (--overwrite) apply, never creating imported-2', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read1 = readHermesFixture(sourceDir)
    const result1 = await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read1.snapshot,
        secrets: read1.secrets,
        options: { overwrite: false, secrets: false },
      },
    )

    const read2 = readHermesFixture(sourceDir)
    const result2 = await applyImport(
      { rootDir, keyMaterial: KEY_MATERIAL },
      {
        snapshot: read2.snapshot,
        secrets: read2.secrets,
        options: { overwrite: true, secrets: false },
      },
    )

    expect(result1.spaceId).toBe(result2.spaceId)
    expect(existsSync(join(rootDir, 'spaces', 'imported'))).toBe(true)
    expect(existsSync(join(rootDir, 'spaces', 'imported-2'))).toBe(false)
  })
})

describe('applyImport — blocked plan', () => {
  it('refuses before writing anything when the (recomputed) plan has blocked entries', async () => {
    const sourceDir = buildHermesFixture()
    const rootDir = freshDir('veduta-apply-target-')
    const read = readHermesFixture(sourceDir)
    // No keyMaterial in deps: `planLegacyImport` (recomputed inside the
    // lock) sees `backupAvailable: false` and blocks naturally —
    // confirmed directly against the same helper before asserting the
    // actual refusal below.
    const blockedPreview = planLegacyImport({
      rootDir,
      snapshot: read.snapshot,
      secrets: read.secrets,
      options: { overwrite: false, secrets: false },
      backupAvailable: false,
    })
    expect(blockedPreview.blocked.length).toBeGreaterThan(0)

    const before = listRecursive(rootDir)
    await expect(
      applyImport(
        { rootDir },
        {
          snapshot: read.snapshot,
          secrets: read.secrets,
          options: { overwrite: false, secrets: false },
        },
      ),
    ).rejects.toThrow(ImportRefusedError)
    expect(listRecursive(rootDir)).toEqual(before)
  })
})

describe('requirePlanItem', () => {
  it('returns the item when the target is present', () => {
    const item: ImportItem = fromPartial({ action: 'skip', target: 'SOUL.md', detail: 'x' })
    expect(requirePlanItem([item], 'SOUL.md')).toBe(item)
  })

  it('throws — never returns undefined — when no item matches the target', () => {
    // This is exactly the fail-open bug `requirePlanItem` closes: before it
    // existed, `plan.items.find(...)` returning `undefined` for a drifted
    // target string made apply silently skip the write for that slot while
    // still reporting success. A well-formed plan (`buildImportPlan`) always
    // has exactly one item per `IMPORT_TARGETS` slot, so reaching this path
    // for a real target means something drifted — that must be loud, not silent.
    expect(() => requirePlanItem([], 'SOUL.md')).toThrow(/no plan item for target "SOUL\.md"/)
  })
})

describe('ownershipTarget', () => {
  it('a non-root process never gets a fix, regardless of the directory owner', () => {
    expect(ownershipTarget({ processUid: 1000, rootUid: 0 })).toBeUndefined()
    expect(ownershipTarget({ processUid: 1000, rootUid: 1000 })).toBeUndefined()
    expect(ownershipTarget({ rootUid: 1000 })).toBeUndefined()
  })

  it('root with a differing directory owner fixes to that uid', () => {
    expect(ownershipTarget({ processUid: 0, rootUid: 1000 })).toBe(1000)
  })

  it('root with a root-owned directory needs no fix', () => {
    expect(ownershipTarget({ processUid: 0, rootUid: 0 })).toBeUndefined()
  })
})
