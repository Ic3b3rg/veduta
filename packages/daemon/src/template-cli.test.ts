import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceTemplateSchema, TemplateBundleSchema, type SurfaceTemplate } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { SpacesEngine } from './spaces-engine.ts'
import { run, TEMPLATE_IMPORT_MAX_BUNDLE_BYTES } from './template-cli.ts'

function sampleTemplate(id: string): SurfaceTemplate {
  return SurfaceTemplateSchema.parse({
    formatVersion: 1,
    id,
    name: 'Tracker',
    intent: 'daily tracker',
    tree: { id: 'root', type: 'Box' },
    stateKeys: [],
    dataProps: [],
    provenance: {
      sourceSurfaceId: 'srf-tracker',
      sourceSpaceId: 'spc-health',
      savedAt: '2026-07-01T00:00:00.000Z',
      savedBy: 'stability',
      origin: 'trusted:user',
    },
  })
}

describe('template-cli run', () => {
  const dirs: string[] = []
  const makeRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), 'veduta-template-cli-'))
    dirs.push(dir)
    return dir
  }
  const collectIo = () => {
    const out: string[] = []
    const err: string[] = []
    return {
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
      out,
      err,
    }
  }

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Seeds a fresh root with one Space holding one saved Template. */
  function seedTemplate(rootDir: string): { spaceId: string } {
    const engine = new SpacesEngine({ rootDir })
    const space = engine.createSpace({ name: 'Health' })
    engine.saveTemplate(space.id, sampleTemplate('tpl-tracker'))
    return { spaceId: space.id }
  }

  it('export writes valid JSON to stdout that TemplateBundleSchema parses', async () => {
    const root = makeRoot()
    const { spaceId } = seedTemplate(root)
    const { io, out } = collectIo()

    const code = await run(['export', '--space', spaceId, '--root', root], { io })

    expect(code).toBe(0)
    const parsed: unknown = JSON.parse(out.join('\n'))
    expect(TemplateBundleSchema.safeParse(parsed).success).toBe(true)
  })

  it('export without --space is a usage error, since a Template id is unique only within its owning Space', async () => {
    const root = makeRoot()
    seedTemplate(root)
    const { io, err } = collectIo()

    const code = await run(['export', '--root', root], { io })

    expect(code).toBe(1)
    expect(err.join(' ')).toMatch(/usage.*export.*--space/i)
  })

  it('import without --apply writes nothing and prints the apply command', async () => {
    const rootA = makeRoot()
    const { spaceId: spaceIdA } = seedTemplate(rootA)
    const bundlePath = join(rootA, 'bundle.json')
    expect(
      await run(['export', '--space', spaceIdA, '--root', rootA, '--file', bundlePath], {
        io: collectIo().io,
      }),
    ).toBe(0)

    const rootB = makeRoot()
    const engineB = new SpacesEngine({ rootDir: rootB })
    const spaceB = engineB.createSpace({ name: 'Fitness' })

    const { io, out } = collectIo()
    const code = await run(
      ['import', '--space', spaceB.id, '--file', bundlePath, '--root', rootB],
      { io },
    )

    expect(code).toBe(0)
    expect(engineB.getTemplate(spaceB.id, 'tpl-tracker')).toBeUndefined()
    expect(out.some((line) => line.includes('--apply'))).toBe(true)
    expect(out[out.length - 1]).toContain('templates import')
  })

  it('import --apply writes the Template and exits 0', async () => {
    const rootA = makeRoot()
    const { spaceId: spaceIdA } = seedTemplate(rootA)
    const bundlePath = join(rootA, 'bundle.json')
    expect(
      await run(['export', '--space', spaceIdA, '--root', rootA, '--file', bundlePath], {
        io: collectIo().io,
      }),
    ).toBe(0)

    const rootB = makeRoot()
    const engineB = new SpacesEngine({ rootDir: rootB })
    const spaceB = engineB.createSpace({ name: 'Fitness' })

    const { io } = collectIo()
    const code = await run(
      ['import', '--space', spaceB.id, '--file', bundlePath, '--root', rootB, '--apply'],
      { io },
    )

    expect(code).toBe(0)
    expect(engineB.getTemplate(spaceB.id, 'tpl-tracker')).toBeDefined()
  })

  it('refuses a bundle file above the byte cap before parsing it', async () => {
    const root = makeRoot()
    const engine = new SpacesEngine({ rootDir: root })
    const space = engine.createSpace({ name: 'Health' })
    const bigPath = join(root, 'too-big.json')
    writeFileSync(
      bigPath,
      JSON.stringify({ padding: 'x'.repeat(TEMPLATE_IMPORT_MAX_BUNDLE_BYTES + 10) }),
    )

    const { io, err } = collectIo()
    const code = await run(['import', '--space', space.id, '--file', bigPath, '--root', root], {
      io,
    })

    expect(code).toBe(2)
    expect(err.join(' ')).toMatch(/byte/i)
  })

  it('gives a usage error with a non-zero exit code when --space or --file is missing', async () => {
    const root = makeRoot()

    const noSpace = collectIo()
    const codeNoSpace = await run(['import', '--file', join(root, 'bundle.json'), '--root', root], {
      io: noSpace.io,
    })
    expect(codeNoSpace).not.toBe(0)
    expect(noSpace.err.join(' ')).toMatch(/usage/i)

    const noFile = collectIo()
    const codeNoFile = await run(['import', '--space', 'spc-x', '--root', root], { io: noFile.io })
    expect(codeNoFile).not.toBe(0)
    expect(noFile.err.join(' ')).toMatch(/usage/i)
  })

  describe('refuses before touching a --root that is not an existing Veduta data directory', () => {
    // `new SpacesEngine`'s constructor runs `ensureBaseLayout`, which creates
    // `spaces/`, `USER.md` and `SOUL.md` on the spot
    // (docs/adr/0010-importer-trust-and-refusal.md invariant #1). A typo'd
    // `--root` used to let a "read-only" `list` or a preview-only `import`
    // silently fabricate a brand-new data root and then report "unknown
    // Space" — every case below must exit non-zero and create nothing.

    it('list', async () => {
      const nonexistentRoot = join(makeRoot(), 'no-such-dir')
      const { io, err } = collectIo()

      const code = await run(['list', '--root', nonexistentRoot], { io })

      expect(code).not.toBe(0)
      expect(err.join(' ')).toMatch(/does not exist/i)
      expect(existsSync(nonexistentRoot)).toBe(false)
    })

    it('import without --apply', async () => {
      const nonexistentRoot = join(makeRoot(), 'no-such-dir')
      const bundlePath = join(nonexistentRoot, 'bundle.json')
      const { io, err } = collectIo()

      const code = await run(
        ['import', '--space', 'spc-x', '--file', bundlePath, '--root', nonexistentRoot],
        { io },
      )

      expect(code).not.toBe(0)
      expect(err.join(' ')).toMatch(/does not exist/i)
      expect(existsSync(nonexistentRoot)).toBe(false)
    })

    it('import --apply', async () => {
      const nonexistentRoot = join(makeRoot(), 'no-such-dir')
      const bundlePath = join(nonexistentRoot, 'bundle.json')
      const { io, err } = collectIo()

      const code = await run(
        ['import', '--space', 'spc-x', '--file', bundlePath, '--root', nonexistentRoot, '--apply'],
        { io },
      )

      expect(code).not.toBe(0)
      expect(err.join(' ')).toMatch(/does not exist/i)
      expect(existsSync(nonexistentRoot)).toBe(false)
    })
  })
})
