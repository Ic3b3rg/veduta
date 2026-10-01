import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { GithubMcpEffects } from './github-mcp-effects.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('does not replay an uncertain GitHub issue write after Gateway restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'veduta-github-effects-'))
  roots.push(root)
  const request = {
    effectId: '34610b3f-ff0b-4b5d-b7da-b90502bb5cbb',
    spaceId: 'spc-work',
    owner: 'example',
    repo: 'disposable',
    title: 'Test title',
    body: 'Test body',
  }
  expect(new GithubMcpEffects(root).begin(request)).toBeUndefined()
  const restarted = new GithubMcpEffects(root)
  expect(() => restarted.status(request)).toThrow('outcome is unknown')
  expect(() => restarted.begin(request)).toThrow('outcome is unknown')
  restarted.confirm(request.effectId, 52)
  expect(new GithubMcpEffects(root).status(request)).toBe(52)
  expect(new GithubMcpEffects(root).begin(request)).toBe(52)
  expect(() => restarted.begin({ ...request, title: 'Different title' })).toThrow(
    'identity was reused',
  )
})
