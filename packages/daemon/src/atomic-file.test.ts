import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeFileAtomicDurable, writeJsonAtomicDurable } from './atomic-file.ts'

describe('atomic file writes', () => {
  it('durably replaces bytes with the requested mode and no live temporary file', () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-atomic-file-'))
    const path = join(root, 'state.bin')
    writeFileSync(path, 'old')

    writeFileAtomicDurable(path, Buffer.from('new'), 0o640)

    expect(readFileSync(path, 'utf8')).toBe('new')
    expect(statSync(path).mode & 0o777).toBe(0o640)
    expect(readdirSync(root).filter((entry) => entry.includes('.tmp-'))).toEqual([])
  })

  it('writes pretty JSON and creates missing parent directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-atomic-json-'))
    const path = join(root, 'nested', 'state.json')
    writeJsonAtomicDurable(path, { ok: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ok: true })
    expect(existsSync(path)).toBe(true)
  })
})
