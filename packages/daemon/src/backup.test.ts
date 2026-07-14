import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BACKUP_FILE_PREFIX,
  BACKUP_FILE_SUFFIX,
  createBackup,
  pruneBackups,
  restoreBackup,
} from './backup.ts'
import { Store } from './store.ts'
import { canonicalAllowlistParams } from './trust-contracts.ts'
import { TrustStore } from './trust-store.ts'

/**
 * `backup.ts` (issue #15 D5): round-trip on a realistic rootDir built from
 * the real `Store`/`TrustStore` classes, plus the security properties a
 * backup module must hold — wrong-key and tampered-ciphertext both fail
 * closed, encryption at rest holds even for the raw `.tar.enc` bytes, and
 * `VACUUM INTO` works against a live (open) SQLite connection since this
 * tool is meant to run alongside a running daemon.
 */

const KEY_MATERIAL = Buffer.from('a test key material, long enough for scrypt')
const PLANTED_SECRET = 'sk-ant-FAKEKEY0015BACKUPdeadbeef'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(dir)
  return dir
}

/** A minimal but real Surface, matching `surface-engine.test.ts`'s fixture shape. */
function testSurface(id: string, spaceId: string): ReturnType<typeof SurfaceSchema.parse> {
  return SurfaceSchema.parse({
    id,
    spaceId,
    title: 'Backup test surface',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        {
          id: 'node-0',
          type: 'Checkbox',
          binding: 'done',
          props: { label: 'Done' },
          actions: [{ name: 'toggle', path: 'fast', stateKey: 'done' }],
        },
      ],
    },
    state: { done: false },
    freshness: { updatedAt: '2026-07-10T12:00:00.000Z', updatedBy: 'seed' },
  })
}

/** Builds a populated rootDir: a Space + fact + surface via Store, a trust audit row + allowlist rule via TrustStore, and a couple of plain files that aren't produced by either engine. */
function buildPopulatedRoot(rootDir: string): { spaceId: string; surfaceId: string } {
  const store = new Store({ rootDir })
  const space = store.spacesEngine.createSpace({ name: 'Backup Test Space' })
  store.writeFact(space.id, 'Likes encrypted backups')
  const surface = testSurface('srf-backup-test', space.id)
  store.createSurface(surface, 'agent')

  const trustStore = new TrustStore(rootDir)
  trustStore.insertAudit(
    { kind: 'action.decision', toolName: 'send_message', decision: 'allow' },
    '2026-07-10T12:00:00.000Z',
  )
  trustStore.upsertAllowlistRule(
    'send_message',
    canonicalAllowlistParams({ to: 'alice@example.com' }),
    'approval-1',
    '2026-07-10T12:00:00.000Z',
  )
  trustStore.dispose()

  mkdirSync(join(rootDir, 'spaces', space.id), { recursive: true })
  writeFileSync(join(rootDir, 'spaces', space.id, 'facts.md'), '# Plain facts file\n')
  mkdirSync(join(rootDir, 'sessions'), { recursive: true })
  writeFileSync(join(rootDir, 'sessions', 's.jsonl'), '{"role":"user","text":"hi"}\n')

  return { spaceId: space.id, surfaceId: surface.id }
}

describe('createBackup / restoreBackup', () => {
  it('round-trips a populated rootDir onto a clean machine', async () => {
    const rootDir = freshDir('veduta-backup-root-')
    const outDir = freshDir('veduta-backup-out-')
    const { spaceId, surfaceId } = buildPopulatedRoot(rootDir)

    const backupPath = await createBackup({ rootDir, outDir, keyMaterial: KEY_MATERIAL })
    expect(backupPath.endsWith(BACKUP_FILE_SUFFIX)).toBe(true)

    const targetRootDir = join(freshDir('veduta-backup-restore-'), 'restored')
    await restoreBackup({ file: backupPath, targetRootDir, keyMaterial: KEY_MATERIAL })

    const restoredStore = new Store({ rootDir: targetRootDir })
    expect(restoredStore.getSpace(spaceId)?.name).toBe('Backup Test Space')
    expect(restoredStore.readFacts(spaceId).active.map((fact) => fact.text)).toEqual([
      'Likes encrypted backups',
    ])
    expect(restoredStore.getSurface(surfaceId)?.title).toBe('Backup test surface')

    const restoredTrustStore = new TrustStore(targetRootDir)
    try {
      const entries = restoredTrustStore.auditEntries(10)
      expect(entries.some((entry) => entry.kind === 'action.decision')).toBe(true)
      expect(restoredTrustStore.listAllowlistRules()).toHaveLength(1)
    } finally {
      restoredTrustStore.dispose()
    }

    expect(readFileSync(join(targetRootDir, 'spaces', spaceId, 'facts.md'), 'utf8')).toBe(
      readFileSync(join(rootDir, 'spaces', spaceId, 'facts.md'), 'utf8'),
    )
    expect(readFileSync(join(targetRootDir, 'sessions', 's.jsonl'), 'utf8')).toBe(
      readFileSync(join(rootDir, 'sessions', 's.jsonl'), 'utf8'),
    )
  })

  it('throws on restore with the wrong key material (GCM auth failure)', async () => {
    const rootDir = freshDir('veduta-backup-root-')
    const outDir = freshDir('veduta-backup-out-')
    buildPopulatedRoot(rootDir)
    const backupPath = await createBackup({ rootDir, outDir, keyMaterial: KEY_MATERIAL })

    const targetRootDir = join(freshDir('veduta-backup-restore-'), 'restored')
    const wrongKey = Buffer.from('a completely different key material')
    await expect(
      restoreBackup({ file: backupPath, targetRootDir, keyMaterial: wrongKey }),
    ).rejects.toThrow()
  })

  it('throws on restore when the ciphertext is tampered with', async () => {
    const rootDir = freshDir('veduta-backup-root-')
    const outDir = freshDir('veduta-backup-out-')
    buildPopulatedRoot(rootDir)
    const backupPath = await createBackup({ rootDir, outDir, keyMaterial: KEY_MATERIAL })

    const bytes = readFileSync(backupPath)
    const newlineIndex = bytes.indexOf(0x0a)
    const tamperedIndex = newlineIndex + 20
    // Flip one byte deep in the ciphertext, well past the header line.
    bytes[tamperedIndex] = (bytes[tamperedIndex] ?? 0) ^ 0xff
    writeFileSync(backupPath, bytes)

    const targetRootDir = join(freshDir('veduta-backup-restore-'), 'restored')
    await expect(
      restoreBackup({ file: backupPath, targetRootDir, keyMaterial: KEY_MATERIAL }),
    ).rejects.toThrow()
  })

  it('throws when restoring into a non-empty target', async () => {
    const rootDir = freshDir('veduta-backup-root-')
    const outDir = freshDir('veduta-backup-out-')
    buildPopulatedRoot(rootDir)
    const backupPath = await createBackup({ rootDir, outDir, keyMaterial: KEY_MATERIAL })

    const targetRootDir = freshDir('veduta-backup-nonempty-')
    writeFileSync(join(targetRootDir, 'already-here.txt'), 'existing data')

    await expect(
      restoreBackup({ file: backupPath, targetRootDir, keyMaterial: KEY_MATERIAL }),
    ).rejects.toThrow()
  })

  it('never leaves a planted plaintext secret readable in the raw .tar.enc bytes', async () => {
    const rootDir = freshDir('veduta-backup-root-')
    const outDir = freshDir('veduta-backup-out-')
    buildPopulatedRoot(rootDir)
    writeFileSync(join(rootDir, 'planted-secret.txt'), PLANTED_SECRET)

    const backupPath = await createBackup({ rootDir, outDir, keyMaterial: KEY_MATERIAL })
    const raw = readFileSync(backupPath)
    expect(raw.includes(Buffer.from(PLANTED_SECRET, 'utf8'))).toBe(false)
    expect(raw.toString('latin1')).not.toContain(PLANTED_SECRET)
  })

  it('safely copies a *.sqlite store while a connection to it is open (live-daemon case)', async () => {
    const rootDir = freshDir('veduta-backup-root-')
    const outDir = freshDir('veduta-backup-out-')
    buildPopulatedRoot(rootDir)

    // Simulate the live daemon: keep a connection open across the backup.
    const liveTrustStore = new TrustStore(rootDir)
    try {
      const backupPath = await createBackup({ rootDir, outDir, keyMaterial: KEY_MATERIAL })
      expect(backupPath.endsWith(BACKUP_FILE_SUFFIX)).toBe(true)

      const targetRootDir = join(freshDir('veduta-backup-restore-'), 'restored')
      await restoreBackup({ file: backupPath, targetRootDir, keyMaterial: KEY_MATERIAL })
      const restoredTrustStore = new TrustStore(targetRootDir)
      try {
        expect(restoredTrustStore.listAllowlistRules()).toHaveLength(1)
      } finally {
        restoredTrustStore.dispose()
      }
    } finally {
      liveTrustStore.dispose()
    }
  })
})

describe('pruneBackups', () => {
  it('keeps the newest `keep` backups and returns the deleted set', () => {
    const outDir = freshDir('veduta-backup-out-')
    const names = [
      `${BACKUP_FILE_PREFIX}2026-01-01T00-00-00.000Z${BACKUP_FILE_SUFFIX}`,
      `${BACKUP_FILE_PREFIX}2026-01-02T00-00-00.000Z${BACKUP_FILE_SUFFIX}`,
      `${BACKUP_FILE_PREFIX}2026-01-03T00-00-00.000Z${BACKUP_FILE_SUFFIX}`,
      `${BACKUP_FILE_PREFIX}2026-01-04T00-00-00.000Z${BACKUP_FILE_SUFFIX}`,
      `${BACKUP_FILE_PREFIX}2026-01-05T00-00-00.000Z${BACKUP_FILE_SUFFIX}`,
    ]
    for (const name of names) writeFileSync(join(outDir, name), 'not a real backup')
    // A file that must never be touched by prune.
    writeFileSync(join(outDir, 'not-a-backup.txt'), 'unrelated')

    const deleted = pruneBackups({ outDir, keep: 3 })

    const [oldest, second] = names
    if (!oldest || !second) throw new Error('test setup: expected fixture names')
    expect(deleted).toHaveLength(2)
    expect(deleted).toEqual([join(outDir, oldest), join(outDir, second)])
    for (const remaining of names.slice(2)) {
      expect(() => readFileSync(join(outDir, remaining))).not.toThrow()
    }
    expect(() => readFileSync(join(outDir, 'not-a-backup.txt'))).not.toThrow()
  })

  it('defaults to keeping 7 and returns an empty array when nothing needs pruning', () => {
    const outDir = freshDir('veduta-backup-out-')
    writeFileSync(
      join(outDir, `${BACKUP_FILE_PREFIX}2026-01-01T00-00-00.000Z${BACKUP_FILE_SUFFIX}`),
      'x',
    )
    expect(pruneBackups({ outDir })).toEqual([])
  })

  it('returns an empty array when outDir does not exist yet', () => {
    const outDir = join(freshDir('veduta-backup-parent-'), 'does-not-exist')
    expect(pruneBackups({ outDir })).toEqual([])
  })
})
