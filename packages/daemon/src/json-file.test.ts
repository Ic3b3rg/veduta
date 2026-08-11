import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readJsonFile } from './json-file.ts'

describe('readJsonFile', () => {
  it('reads JSON and preserves caller-specific error context', () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-json-file-'))
    const valid = join(root, 'valid.json')
    const invalid = join(root, 'invalid.json')
    writeFileSync(valid, '{"ok":true}')
    writeFileSync(invalid, '{')

    expect(readJsonFile(valid, { description: 'test config' })).toEqual({ ok: true })
    expect(() =>
      readJsonFile(invalid, { description: 'test config', refusal: 'refusing to reset state' }),
    ).toThrow(/invalid JSON in test config .* — refusing to reset state/)
  })
})
