import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FirstPartySkills, loadFirstPartySkill } from './skill-catalog.ts'

function fixture(markdown: string, extras: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'veduta-skill-'))
  const dir = join(root, 'fixture-skill')
  mkdirSync(dir)
  writeFileSync(join(dir, 'SKILL.md'), markdown)
  for (const [path, content] of Object.entries(extras)) {
    const full = join(dir, path)
    if (path.includes('/')) mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(full, content)
  }
  return { root, dir }
}

const valid =
  '---\nname: fixture-skill\ndescription: A fixture procedure.\nmetadata:\n  veduta.tools: search_mailbox\n---\n\n# Procedure\n\n[Read](references/notes.md)\n'

describe('first-party Skills', () => {
  it('discovers only relevant metadata and validates the bundled packages', () => {
    const catalog = new FirstPartySkills()
    const names = ['resolve_mailbox_scope', 'search_mailbox']
    expect(
      catalog.applicable('Summarize Gmail newsletters', names).map((skill) => skill.id),
    ).toEqual(['gmail-connector', 'mailbox-assistant'])
    expect(catalog.metadata('Plan dinner', names)).toBe('')
    expect(catalog.metadata('Search Gmail', ['search_memory'])).toBe('')
    const withGmailAccount = new FirstPartySkills(undefined, () => 'gmail')
    expect(
      withGmailAccount
        .applicable('Set up Himalaya', [
          'execute_command',
          'install_himalaya',
          'resolve_mailbox_scope',
          'search_mailbox',
        ])
        .map((skill) => skill.id),
    ).toContain('himalaya-connector')
  })

  it('rejects unsupported fields, broken links, executable files, and oversized packages', () => {
    const cases = [
      [valid.replace('description:', 'prompt: secret\ndescription:'), {}, /unsupported field/],
      [valid, {}, /broken reference/],
      [valid, { 'references/notes.md': 'Notes', 'run.sh': 'echo no' }, /package file/],
      [valid + 'word\n'.repeat(501), { 'references/notes.md': 'Notes' }, /500 lines/],
      [valid + 'word '.repeat(6000), { 'references/notes.md': 'Notes' }, /5,000 tokens/],
    ] as const
    for (const [markdown, extras, error] of cases) {
      const { root, dir } = fixture(markdown, extras)
      try {
        expect(() => loadFirstPartySkill(dir)).toThrow(error)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  })
})
