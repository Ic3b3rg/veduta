import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const ISSUES_DIR = join(REPO_ROOT, 'issues')

function issueSpecifications(): Array<{ number: string; file: string }> {
  return readdirSync(ISSUES_DIR)
    .flatMap((file) => {
      const match = /^(\d{3})-.+\.md$/.exec(file)
      return match ? [{ number: match[1]!, file }] : []
    })
    .sort((left, right) => left.number.localeCompare(right.number))
}

function indexedSpecifications(): Array<{ number: string; file: string }> {
  const index = readFileSync(join(ISSUES_DIR, 'README.md'), 'utf8')
  return [...index.matchAll(/^\|\s*(\d{3})\s*\|\s*\[[^\]]+\]\(([^)]+)\)\s*\|/gm)]
    .map((match) => ({ number: match[1]!, file: basename(match[2]!) }))
    .sort((left, right) => left.number.localeCompare(right.number))
}

describe('canonical issue index', () => {
  it('lists every numbered issue specification exactly once', () => {
    expect(indexedSpecifications()).toEqual(issueSpecifications())
  })
})
