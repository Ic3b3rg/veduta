import { readdirSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_DATA_VERSION,
  ensureDataVersion,
  readDataVersion,
  stampDataVersion,
} from './data-version.ts'

describe('readDataVersion / stampDataVersion', () => {
  it('returns undefined when no marker file exists', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-dataversion-none-'))
    expect(readDataVersion(rootDir)).toBeUndefined()
  })

  it('round-trips a stamped value, creating the root dir if missing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'veduta-dataversion-stamp-'))
    const rootDir = join(parent, 'nested', 'root')

    stampDataVersion(rootDir, 3)

    expect(readDataVersion(rootDir)).toBe(3)
  })

  it('leaves no .tmp file behind after stamping', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-dataversion-tmp-'))
    stampDataVersion(rootDir, 1)
    expect(readdirSync(rootDir)).toEqual(['data-version.json'])
  })

  it('throws a plain error when the marker file is not valid JSON', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-dataversion-corrupt-'))
    await writeFile(join(rootDir, 'data-version.json'), 'not json at all')

    expect(() => readDataVersion(rootDir)).toThrow(/is corrupt/)
  })

  it('throws a plain error when the marker file does not match the expected shape', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-dataversion-badshape-'))
    await writeFile(join(rootDir, 'data-version.json'), JSON.stringify({ dataVersion: 'nope' }))

    expect(() => readDataVersion(rootDir)).toThrow(/is corrupt/)
  })
})

describe('ensureDataVersion', () => {
  it('stamps a missing root fresh at CURRENT_DATA_VERSION', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'veduta-ensure-missing-'))
    const rootDir = join(parent, 'does-not-exist-yet')

    const result = ensureDataVersion(rootDir)

    expect(result).toEqual({ action: 'stamped-fresh', dataVersion: CURRENT_DATA_VERSION })
    expect(readDataVersion(rootDir)).toBe(CURRENT_DATA_VERSION)
  })

  it('stamps an existing empty root fresh at CURRENT_DATA_VERSION', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-ensure-empty-'))

    const result = ensureDataVersion(rootDir)

    expect(result).toEqual({ action: 'stamped-fresh', dataVersion: CURRENT_DATA_VERSION })
    expect(readDataVersion(rootDir)).toBe(CURRENT_DATA_VERSION)
  })

  it('boots ok when the marker already matches CURRENT_DATA_VERSION', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-ensure-ok-'))
    stampDataVersion(rootDir, CURRENT_DATA_VERSION)

    const result = ensureDataVersion(rootDir)

    expect(result).toEqual({ action: 'ok', dataVersion: CURRENT_DATA_VERSION })
  })

  it('refuses with a plain, actionable message naming both numbers when the marker does not match', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-ensure-mismatch-'))
    stampDataVersion(rootDir, 999)

    expect(() => ensureDataVersion(rootDir)).toThrow(
      new RegExp(`dataVersion 999.*expects ${CURRENT_DATA_VERSION}`, 's'),
    )
  })

  it('bootstraps a non-empty pre-issue-43 root with no marker to CURRENT_DATA_VERSION', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'veduta-ensure-bootstrap-'))
    // Simulates a data root that predates issue #43: real files, no
    // data-version.json marker at all.
    await writeFile(join(rootDir, 'surfaces.sqlite'), 'pretend-sqlite-bytes')

    const result = ensureDataVersion(rootDir)

    expect(result).toEqual({ action: 'bootstrapped', dataVersion: CURRENT_DATA_VERSION })
    expect(readDataVersion(rootDir)).toBe(CURRENT_DATA_VERSION)
  })
})
