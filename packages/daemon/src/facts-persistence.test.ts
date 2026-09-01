import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { factRecordIds, formatFactsMarkdown, type FactsDocument } from './facts.ts'
import { SpacesEngine } from './spaces-engine.ts'

describe('FACTS persistence boundary (issues/129-secret-safe-atomic-facts-writes.md)', () => {
  describe('interactive writes', () => {
    it('sanitizes a proposed fact before Curator comparison', () => {
      const { engine, factsPath, spaceId } = createHarness()
      engine.writeFact(spaceId, 'I like oats')
      const before = readFileSync(factsPath, 'utf8')

      const result = engine.writeFact(spaceId, 'I like o\u200Bats')

      expect(result.operation).toBe('noop')
      expect(result.fact.text).toBe('I like oats')
      expect(readFileSync(factsPath, 'utf8')).toBe(before)
    })

    it('sanitizes headings and origins before parsing a document for rewrite', () => {
      const { engine, factsPath, spaceId } = createHarness()
      const markdown = formatFactsMarkdown(
        {
          active: [{ text: 'Current fact', noted: '2026-06-01', origin: 'untrusted:gmail' }],
          dormant: [{ text: 'Resting fact', noted: '2026-05-01', dormantAt: '2026-06-02' }],
          superseded: [
            {
              text: 'Old fact',
              noted: '2026-04-01',
              supersededAt: '2026-05-01',
              supersededBy: 'Current fact',
            },
          ],
        },
        '2026-07-01',
      )
        .replace('untrusted:gmail', 'untrusted:g\u200Bmail')
        .replace('## Dormant', '## Dor\u200Bmant')
        .replace('## Superseded', '## Super\u200Bseded')
      writeFileSync(factsPath, markdown)

      engine.writeFact(spaceId, 'Another fact')

      expect(engine.readFacts(spaceId)).toEqual({
        active: [
          { text: 'Current fact', noted: '2026-06-01', origin: 'untrusted:gmail' },
          { text: 'Another fact', noted: '2026-07-03' },
        ],
        dormant: [{ text: 'Resting fact', noted: '2026-05-01', dormantAt: '2026-06-02' }],
        superseded: [
          {
            text: 'Old fact',
            noted: '2026-04-01',
            supersededAt: '2026-05-01',
            supersededBy: 'Current fact',
          },
        ],
      })
    })

    it('rejects a hidden credential in raw Markdown before parsing can discard its origin', () => {
      const { engine, factsPath, spaceId } = createHarness()
      const before = `# FACTS

- Current fact (noted: 2026-06-01) — origin: untrusted:sk-\u200B${'a'.repeat(16)}

## Dormant

_None yet._

## Superseded

_None yet._
`
      writeFileSync(factsPath, before)

      expect(() => engine.writeFact(spaceId, 'Another fact')).toThrow(
        'Secrets cannot be stored in FACTS',
      )

      expect(readFileSync(factsPath, 'utf8')).toBe(before)
    })

    it('restores the previous bytes when the directory durability check fails after rename', () => {
      const { engine, factsPath, spaceDir, spaceId } = createHarness()
      engine.writeFact(spaceId, 'I like oats')
      const before = readFileSync(factsPath)
      const eventCount = engine.readRecent(spaceId, 20).length

      // Write + execute allow the temporary file and rename to complete, but
      // no read bit makes the following parent-directory open fail.
      withDirectoryMode(spaceDir, 0o300, () => {
        expect(() => engine.writeFact(spaceId, 'I like rice')).toThrow(/EACCES|permission denied/i)
      })

      expect(readFileSync(factsPath)).toEqual(before)
      expect(engine.readFacts(spaceId).active.map((fact) => fact.text)).toEqual(['I like oats'])
      expect(engine.readRecent(spaceId, 20)).toHaveLength(eventCount)
    })
  })

  describe('Space merge', () => {
    it('sanitizes and preserves every section, record field, origin, and order', () => {
      const rootDir = tempRoot()
      const engine = new SpacesEngine({ rootDir, now: fixedNow })
      const target = engine.createSpace({ name: 'Health' })
      const source = engine.createSpace({ name: 'Food' })
      writeFactsFile(rootDir, target.slug, {
        active: [
          { text: 'Target a\u200Bctive', noted: '2026-\u200B06-01', origin: 'untrusted:gmail' },
        ],
        dormant: [
          {
            text: 'Target dor\u202Emant',
            noted: '2026-05-01',
            dormantAt: '2026-\u200B06-02',
            origin: 'untrusted:import',
          },
        ],
        superseded: [
          {
            text: 'Target old',
            noted: '2026-04-01',
            supersededAt: '2026-05-01',
            supersededBy: 'Target n\u200Bew',
            origin: 'untrusted:external',
          },
        ],
      })
      writeFactsFile(rootDir, source.slug, {
        active: [{ text: 'Source ac\u2066tive', noted: '2026-06-03', origin: 'untrusted:import' }],
        dormant: [{ text: 'Source dor\u200Bmant', noted: '2026-05-03', dormantAt: '2026-06-04' }],
        superseded: [
          {
            text: 'Source old',
            noted: '2026-04-03',
            supersededAt: '2026-05-03',
            supersededBy: 'Source n\u200Bew',
          },
        ],
      })

      engine.mergeSpaces(target.id, source.id)

      expect(engine.readFacts(target.id)).toEqual({
        active: [
          { text: 'Target active', noted: '2026-06-01', origin: 'untrusted:gmail' },
          { text: 'Source active', noted: '2026-06-03', origin: 'untrusted:import' },
        ],
        dormant: [
          {
            text: 'Target dormant',
            noted: '2026-05-01',
            dormantAt: '2026-06-02',
            origin: 'untrusted:import',
          },
          { text: 'Source dormant', noted: '2026-05-03', dormantAt: '2026-06-04' },
        ],
        superseded: [
          {
            text: 'Target old',
            noted: '2026-04-01',
            supersededAt: '2026-05-01',
            supersededBy: 'Target new',
            origin: 'untrusted:external',
          },
          {
            text: 'Source old',
            noted: '2026-04-03',
            supersededAt: '2026-05-03',
            supersededBy: 'Source new',
          },
        ],
      })
    })

    it('rejects a credential without changing or archiving either Space', () => {
      const rootDir = tempRoot()
      const engine = new SpacesEngine({ rootDir, now: fixedNow })
      const target = engine.createSpace({ name: 'Health' })
      const source = engine.createSpace({ name: 'Food' })
      writeFactsFile(rootDir, source.slug, {
        active: [{ text: `Remember sk-${'a'.repeat(16)}`, noted: '2026-06-03' }],
        dormant: [],
        superseded: [],
      })
      const targetPath = factsPath(rootDir, target.slug)
      const sourcePath = factsPath(rootDir, source.slug)
      const targetBefore = readFileSync(targetPath)
      const sourceBefore = readFileSync(sourcePath)

      expect(() => engine.mergeSpaces(target.id, source.id)).toThrow(
        'Secrets cannot be stored in FACTS',
      )

      expect(readFileSync(targetPath)).toEqual(targetBefore)
      expect(readFileSync(sourcePath)).toEqual(sourceBefore)
      expect(engine.getSpace(source.id)?.archived).toBe(false)
    })

    it('leaves both Spaces unchanged when replacement cannot start', () => {
      const rootDir = tempRoot()
      const engine = new SpacesEngine({ rootDir, now: fixedNow })
      const target = engine.createSpace({ name: 'Health' })
      const source = engine.createSpace({ name: 'Food' })
      engine.writeFact(source.id, 'I like barley')
      const targetDir = join(rootDir, 'spaces', target.slug)
      const targetPath = factsPath(rootDir, target.slug)
      const before = readFileSync(targetPath)

      withDirectoryMode(targetDir, 0o500, () => {
        expect(() => engine.mergeSpaces(target.id, source.id)).toThrow(/EACCES|permission denied/i)
      })

      expect(readFileSync(targetPath)).toEqual(before)
      expect(engine.getSpace(source.id)?.archived).toBe(false)
    })
  })

  describe('Reflection demotion', () => {
    it('sanitizes and preserves every section while moving the selected record', () => {
      const { engine, rootDir, spaceId, spaceSlug } = createHarness()
      writeFactsFile(rootDir, spaceSlug, {
        active: [
          { text: 'I like o\u200Bats', noted: '2026-\u200B06-01', origin: 'untrusted:gmail' },
        ],
        dormant: [
          { text: 'Existing dor\u202Emant', noted: '2026-05-01', dormantAt: '2026-\u200B06-02' },
        ],
        superseded: [
          {
            text: 'Previous preference',
            noted: '2026-04-01',
            supersededAt: '2026-05-01',
            supersededBy: 'Current pref\u2066erence',
            origin: 'untrusted:import',
          },
        ],
      })
      const before = engine.readFacts(spaceId)
      const targetId = factRecordIds(before, '2026-07-03').get(before.active[0]!)
      expect(targetId).toBeDefined()

      const demoted = engine.demoteFacts(spaceId, [targetId!])

      expect(demoted).toEqual([
        {
          text: 'I like oats',
          noted: '2026-06-01',
          dormantAt: '2026-07-03',
          origin: 'untrusted:gmail',
        },
      ])
      expect(engine.readFacts(spaceId)).toEqual({
        active: [],
        dormant: [
          { text: 'Existing dormant', noted: '2026-05-01', dormantAt: '2026-06-02' },
          {
            text: 'I like oats',
            noted: '2026-06-01',
            dormantAt: '2026-07-03',
            origin: 'untrusted:gmail',
          },
        ],
        superseded: [
          {
            text: 'Previous preference',
            noted: '2026-04-01',
            supersededAt: '2026-05-01',
            supersededBy: 'Current preference',
            origin: 'untrusted:import',
          },
        ],
      })
      const event = engine.readRecent(spaceId, 20).find((entry) => entry.type === 'fact.demote')
      expect(event?.payload?.['ids']).toEqual([targetId])
    })

    it('rejects a credential in a retained section without moving a record or appending an Event', () => {
      const { engine, factsPath, rootDir, spaceId, spaceSlug } = createHarness()
      writeFactsFile(rootDir, spaceSlug, {
        active: [{ text: 'I like oats', noted: '2026-06-01' }],
        dormant: [{ text: `Remember sk-${'a'.repeat(16)}`, noted: '2026-05-01' }],
        superseded: [],
      })
      const document = engine.readFacts(spaceId)
      const targetId = factRecordIds(document, '2026-07-03').get(document.active[0]!)
      const before = readFileSync(factsPath)
      const eventCount = engine.readRecent(spaceId, 20).length

      expect(() => engine.demoteFacts(spaceId, [targetId!])).toThrow(
        'Secrets cannot be stored in FACTS',
      )

      expect(readFileSync(factsPath)).toEqual(before)
      expect(engine.readRecent(spaceId, 20)).toHaveLength(eventCount)
    })

    it('leaves FACTS and the Event log unchanged when replacement cannot start', () => {
      const { engine, factsPath, spaceDir, spaceId } = createHarness()
      engine.writeFact(spaceId, 'I like oats')
      const document = engine.readFacts(spaceId)
      const targetId = factRecordIds(document, '2026-07-03').get(document.active[0]!)
      const before = readFileSync(factsPath)
      const eventCount = engine.readRecent(spaceId, 20).length

      withDirectoryMode(spaceDir, 0o500, () => {
        expect(() => engine.demoteFacts(spaceId, [targetId!])).toThrow(/EACCES|permission denied/i)
      })

      expect(readFileSync(factsPath)).toEqual(before)
      expect(engine.readRecent(spaceId, 20)).toHaveLength(eventCount)
    })
  })
})

function createHarness(): {
  engine: SpacesEngine
  factsPath: string
  rootDir: string
  spaceDir: string
  spaceId: string
  spaceSlug: string
} {
  const rootDir = tempRoot()
  const engine = new SpacesEngine({ rootDir, now: fixedNow })
  const space = engine.createSpace({ name: 'Health' })
  const spaceDir = join(rootDir, 'spaces', space.slug)
  return {
    engine,
    factsPath: factsPath(rootDir, space.slug),
    rootDir,
    spaceDir,
    spaceId: space.id,
    spaceSlug: space.slug,
  }
}

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'veduta-facts-persistence-'))
}

function factsPath(rootDir: string, slug: string): string {
  return join(rootDir, 'spaces', slug, 'FACTS.md')
}

function writeFactsFile(rootDir: string, slug: string, document: FactsDocument): void {
  writeFileSync(factsPath(rootDir, slug), formatFactsMarkdown(document, '2026-07-01'))
}

function withDirectoryMode<T>(path: string, mode: number, operation: () => T): T {
  chmodSync(path, mode)
  try {
    return operation()
  } finally {
    chmodSync(path, 0o700)
  }
}
