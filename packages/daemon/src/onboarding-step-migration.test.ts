import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ImportPlanSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { ImportRefusedError } from './import-apply.ts'
import { loadOnboardingConfig } from './onboarding-config.ts'
import { OnboardingStepError } from './onboarding-status.ts'
import {
  applyMigrationChoice,
  previewLegacyImport,
  runLegacyImport,
  type MigrationImportDeps,
} from './onboarding-step-migration.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-onboarding-migration-'))
  return rootDir
}

const KEY_MATERIAL = Buffer.from('a test migration vault key, long enough for scrypt derivation')

/** The flat staged layout the installer writes (`docs/adr/0010-importer-trust-and-refusal.md`): `<root>/import-source/hermes/{SOUL,USER,MEMORY}.md`. */
function buildStagedHermesFixture(
  rootDir: string,
  overrides: { soul?: string; user?: string; memory?: string } = {},
): string {
  const stagedDir = join(rootDir, 'import-source', 'hermes')
  mkdirSync(stagedDir, { recursive: true })
  writeFileSync(join(stagedDir, 'SOUL.md'), overrides.soul ?? 'You are calm and thorough.\n')
  writeFileSync(join(stagedDir, 'USER.md'), overrides.user ?? 'Name: Test User\nTimezone: UTC\n')
  writeFileSync(
    join(stagedDir, 'MEMORY.md'),
    overrides.memory ?? 'Prefers async updates.\n§\nShips on Thursdays.',
  )
  return stagedDir
}

function freshDeps(
  rootDir: string,
  overrides: Partial<MigrationImportDeps> = {},
): MigrationImportDeps {
  return {
    rootDir,
    vault: undefined,
    keyMaterial: KEY_MATERIAL,
    // Pinned to a clean temp dir rather than the real `~` so a stray
    // `.hermes`/`.openclaw` on the host running the tests never changes
    // what preview/apply finds (same idiom as `onboarding-routes.test.ts`).
    env: { VEDUTA_LEGACY_HOME: rootDir },
    ...overrides,
  }
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

describe('applyMigrationChoice', () => {
  it('records migrate-later and completes the step', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'migrate-later')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('migrate-later')
    expect(config.steps.migration).toBe('completed')
  })

  it('records manual and completes the step', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'manual')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('manual')
    expect(config.steps.migration).toBe('completed')
  })

  it('is idempotent: re-applying the same choice leaves the same recorded state', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'migrate-later')
    applyMigrationChoice(dir, 'migrate-later')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('migrate-later')
    expect(config.steps.migration).toBe('completed')
  })

  it('re-applying with a different choice overwrites the marker', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'migrate-later')
    applyMigrationChoice(dir, 'manual')
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('manual')
    expect(config.steps.migration).toBe('completed')
  })

  it('preserves unrelated existing steps', () => {
    const dir = freshRoot()
    applyMigrationChoice(dir, 'manual')
    const before = loadOnboardingConfig(dir)
    expect(before.steps).toEqual({ migration: 'completed' })
  })
})

describe('previewLegacyImport', () => {
  it('returns a schema-valid plan and writes nothing to the data dir', () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const deps = freshDeps(dir)

    const before = listRecursive(dir)
    const plan = previewLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: false })

    expect(ImportPlanSchema.safeParse(plan).success).toBe(true)
    expect(listRecursive(dir)).toEqual(before)
  })

  it('prefers a staged import-source/hermes over a VEDUTA_LEGACY_HOME fallback', () => {
    const dir = freshRoot()
    const staged = buildStagedHermesFixture(dir, { soul: 'Staged personality.\n' })
    const legacyHome = mkdtempSync(join(tmpdir(), 'veduta-legacy-home-'))
    mkdirSync(join(legacyHome, '.hermes'), { recursive: true })
    writeFileSync(join(legacyHome, '.hermes', 'SOUL.md'), 'Fallback personality.\n')

    try {
      const deps = freshDeps(dir, { env: { VEDUTA_LEGACY_HOME: legacyHome } })
      const plan = previewLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: false })
      expect(plan.sourceDir).toBe(realpathSync(staged))
    } finally {
      rmSync(legacyHome, { recursive: true, force: true })
    }
  })

  it('secrets: true is rejected with a 400 before the source is even resolved', () => {
    const dir = freshRoot()
    // No staged fixture at all: if source resolution ran first this would
    // throw the 409 dead end instead, proving the secrets check comes first.
    const deps = freshDeps(dir)

    let caught: unknown
    try {
      previewLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: true })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OnboardingStepError)
    const error = caught as OnboardingStepError
    expect(error.statusCode).toBe(400)
    expect(error.message).toContain('CLI-only')
    expect(error.message).toContain('--secrets')
  })

  it('no readable source throws a 409 naming the exact CLI command', () => {
    const dir = freshRoot()
    const deps = freshDeps(dir)

    let caught: unknown
    try {
      previewLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: false })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(OnboardingStepError)
    const error = caught as OnboardingStepError
    expect(error.statusCode).toBe(409)
    // The script was renamed `import` -> `import-legacy` (pnpm's own
    // built-in `import` command shadowed the old name entirely). The
    // dead end now also carries `--home`, pointing at the admin's own
    // resolved home (here, the same `dir` this test pinned via
    // `VEDUTA_LEGACY_HOME`, since nothing was detected to override it) --
    // omitting it would have this `sudo`-run command search root's home
    // instead of the admin's.
    expect(error.message).toContain(
      `sudo pnpm --filter @veduta/daemon import-legacy hermes --apply --root '${dir}' --home '${dir}'`,
    )
  })

  it('a resolved candidate that is a file, not a directory, still yields the 409 dead end (never a generic 500)', () => {
    const dir = freshRoot()
    const legacyHome = mkdtempSync(join(tmpdir(), 'veduta-legacy-home-'))
    // `.hermes` exists but is a plain file -- `resolveLegacyDir`'s own
    // `existsSync` check alone would have accepted this as "found"; only
    // `resolveMigrationSourceDir`'s own readability check rejects it,
    // so resolution correctly reports "nothing found" instead of handing a
    // non-directory path to `readLegacySource`, which would throw
    // `ImportSourceMissingError` past `sendStepError`'s specific mappings.
    writeFileSync(join(legacyHome, '.hermes'), 'not a directory')

    try {
      const deps = freshDeps(dir, { env: { VEDUTA_LEGACY_HOME: legacyHome } })
      let caught: unknown
      try {
        previewLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: false })
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(OnboardingStepError)
      expect((caught as OnboardingStepError).statusCode).toBe(409)
    } finally {
      rmSync(legacyHome, { recursive: true, force: true })
    }
  })
})

describe('runLegacyImport', () => {
  it('completes the migration step with migrationChoice "imported" and removes the staged copy', async () => {
    const dir = freshRoot()
    const staged = buildStagedHermesFixture(dir)
    const deps = freshDeps(dir)

    await runLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: false })

    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('imported')
    expect(config.steps.migration).toBe('completed')
    expect(existsSync(staged)).toBe(false)
  })

  it('a failure removing the staged copy never undoes an already-completed import', async () => {
    const dir = freshRoot()
    const staged = buildStagedHermesFixture(dir)
    // The removal is injected rather than provoked with a chmod: making the staged
    // directory unwritable also propagates into `createBackup`'s recursive copy of
    // `rootDir`, so the run would fail at the backup step and this test would prove
    // nothing about the cleanup.
    let attempted = false
    const deps = {
      ...freshDeps(dir),
      removeStagedCopy: () => {
        attempted = true
        throw new Error('EACCES: staged copy could not be removed')
      },
    }

    const result = await runLegacyImport(deps, {
      source: 'hermes',
      overwrite: false,
      secrets: false,
    })

    // The cleanup genuinely ran and genuinely failed (proving this test exercises the
    // failure it claims to) -- yet the import is still fully recorded.
    expect(result).toBeDefined()
    expect(attempted).toBe(true)
    expect(existsSync(staged)).toBe(true)
    const config = loadOnboardingConfig(dir)
    expect(config.migrationChoice).toBe('imported')
    expect(config.steps.migration).toBe('completed')
  })

  it('preview and apply agree on blocked/requiresOverwrite for the same options', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const deps = freshDeps(dir)

    const previewPlan = previewLegacyImport(deps, {
      source: 'hermes',
      overwrite: false,
      secrets: false,
    })
    const result = await runLegacyImport(deps, {
      source: 'hermes',
      overwrite: false,
      secrets: false,
    })

    expect(result.plan.blocked).toEqual(previewPlan.blocked)
    expect(result.plan.requiresOverwrite).toBe(previewPlan.requiresOverwrite)
  })

  it('a second run without --overwrite refuses with ImportRefusedError, not silently repeating', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const deps1 = freshDeps(dir)
    await runLegacyImport(deps1, { source: 'hermes', overwrite: false, secrets: false })

    // The installer would re-stage a re-detected install on a second wizard run.
    buildStagedHermesFixture(dir)
    const deps2 = freshDeps(dir)
    await expect(
      runLegacyImport(deps2, { source: 'hermes', overwrite: false, secrets: false }),
    ).rejects.toThrow(ImportRefusedError)
  })

  it('secrets: true is rejected before any write', async () => {
    const dir = freshRoot()
    buildStagedHermesFixture(dir)
    const deps = freshDeps(dir)

    const before = listRecursive(dir)
    await expect(
      runLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: true }),
    ).rejects.toThrow(OnboardingStepError)
    expect(listRecursive(dir)).toEqual(before)
  })

  it('no readable source refuses before any write', async () => {
    const dir = freshRoot()
    const deps = freshDeps(dir)

    const before = listRecursive(dir)
    await expect(
      runLegacyImport(deps, { source: 'hermes', overwrite: false, secrets: false }),
    ).rejects.toThrow(OnboardingStepError)
    expect(listRecursive(dir)).toEqual(before)
  })
})
