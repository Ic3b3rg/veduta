import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GithubMcpService, githubConnectionReview } from './github-mcp-service.ts'
import { SecretsVault } from './secrets-vault.ts'
import { ServiceConnections } from './service-connections.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GitHub MCP verification and Space scope', () => {
  it.each([
    { name: 'numeric issue response', response: { number: 52 }, accepted: true },
    {
      name: 'reviewed server minimal response',
      response: { id: '9812345678', url: 'https://github.com/example/disposable/issues/52' },
      accepted: true,
    },
    {
      name: 'numeric REST response',
      response: { number: 52, url: 'https://api.github.com/repos/example/disposable/issues/52' },
      accepted: true,
    },
    {
      name: 'database id without issue URL',
      response: { id: '9812345678' },
      accepted: false,
    },
    {
      name: 'conflicting numeric identity',
      response: { number: 52, url: 'https://github.com/example/disposable/issues/53' },
      accepted: false,
    },
    ...[
      'https://github.com/other/disposable/issues/52',
      'https://github.com/example/other/issues/52',
      'https://evil.test/example/disposable/issues/52',
      'https://github.com.evil.test/example/disposable/issues/52',
      'https://user@github.com/example/disposable/issues/52',
      'http://github.com/example/disposable/issues/52',
      'https://github.com/example/disposable/pull/52',
      'https://github.com/example/disposable/issues/0',
      'https://github.com/example/disposable/issues/01',
      'https://github.com/example/disposable/issues/9007199254740992',
      'https://github.com/example/disposable/issues/52?foo=1',
      'https://github.com/example/disposable/issues/52#comment',
      'https://github.com/example/disposable/issues/52/',
      ' https://github.com/example/disposable/issues/52',
      'https://github.com/other/../example/disposable/issues/52',
    ].map((url) => ({
      name: `unapproved URL ${url}`,
      response: { id: '9812345678', url },
      accepted: false,
    })),
  ])('handles $name without replaying the write', async ({ response, accepted }) => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-github-write-'))
    roots.push(root)
    const vault = SecretsVault.open(root, Buffer.from('test-only-vault-key'))
    const connections = new ServiceConnections(root)
    const review = githubConnectionReview('example', 'disposable', undefined, 'write')
    const attempt = connections.createAttempt({
      submissionId: '795a430f-5d41-4c81-ab45-8f86011e94f6',
      turnId: 'cht-write',
      spaceId: 'spc-work',
      requestSummary: 'Create a GitHub issue',
      review,
    })
    const writes: string[] = []
    const readbacks: string[] = []
    let failNext = false
    let mismatchReadback = false
    const service = new GithubMcpService({
      rootDir: root,
      connections,
      vault,
      fetchFn: async (url) => {
        if (String(url).endsWith('/user'))
          return new Response(JSON.stringify({ login: 'reviewed-user' }), { status: 200 })
        readbacks.push(String(url))
        return new Response(
          JSON.stringify({
            number: 52,
            title: mismatchReadback ? 'Different title' : 'Test title',
            body: 'Test body',
          }),
          {
            status: 200,
          },
        )
      },
      install: async () => '/reviewed/github-mcp-server',
      createClient: ({ mode }) => ({
        start: async () => {},
        discoverTools: async () => ({
          name: mode === 'write' ? 'issue_write' : 'list_issues',
          schemaSha256: review.toolSchemaSha256!,
        }),
        listOpenIssues: async () => {
          throw new Error('Unexpected GitHub issue read')
        },
        createIssue: async (owner, repo) => {
          writes.push(`${owner}/${repo}`)
          if (failNext) throw new Error('Connection lost after sending the write')
          return { text: JSON.stringify(response), schemaSha256: review.toolSchemaSha256! }
        },
        stop: async () => {},
      }),
    })
    const first = {
      effectId: '087071fd-74d1-40d8-a0de-a9481db24f37',
      spaceId: 'spc-work',
      repository: { owner: 'example', name: 'disposable' },
      title: 'Test title',
      body: 'Test body',
    }
    try {
      connections.beginAuthorization(attempt.id)
      await service.verifyAttempt(attempt.id, 'github_pat_' + 'x'.repeat(30))
      await expect(service.createIssue(first)).rejects.toThrow('not granted')
      const verified = connections.attempt(attempt.id)!
      const grant = connections.grant(
        attempt.id,
        verified.verifiedAccount!,
        verified.verifiedScopes!,
      )
      if (!accepted) {
        await expect(service.createIssue(first)).rejects.toThrow('outcome is unknown')
        await expect(service.createIssue(first)).rejects.toThrow('outcome is unknown')
        expect(writes).toEqual(['example/disposable'])
        expect(readbacks).toEqual([])
        return
      }
      expect((await service.createIssue(first)).number).toBe(52)
      expect((await service.createIssue(first)).number).toBe(52)
      expect(writes).toEqual(['example/disposable'])
      expect(readbacks).toEqual(['https://api.github.com/repos/example/disposable/issues/52'])
      await expect(service.createIssue({ ...first, spaceId: 'spc-health' })).rejects.toThrow(
        'not granted',
      )
      failNext = true
      const uncertain = { ...first, effectId: 'a4de09bb-2a66-4682-a7b7-1931ddf855f5' }
      await expect(service.createIssue(uncertain)).rejects.toThrow('Connection lost')
      await expect(service.createIssue(uncertain)).rejects.toThrow('outcome is unknown')
      expect(writes).toHaveLength(2)
      failNext = false
      mismatchReadback = true
      const mismatch = { ...first, effectId: '686a3826-dd8c-4d12-90b1-491e79f6d6d1' }
      await expect(service.createIssue(mismatch)).rejects.toThrow(
        'did not match the approved content',
      )
      await expect(service.createIssue(mismatch)).rejects.toThrow('outcome is unknown')
      expect(writes).toHaveLength(3)
      connections.disableGrant(grant.id)
      await expect(service.createIssue(first)).rejects.toThrow('not granted')
    } finally {
      service.stop()
    }
  })

  it('discovers without task content, then runs one bounded read only after an exact Space grant', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-github-service-'))
    roots.push(root)
    const vault = SecretsVault.open(root, Buffer.from('test-only-vault-key'))
    const connections = new ServiceConnections(root)
    const review = githubConnectionReview('example', 'disposable')
    const attempt = connections.createAttempt({
      submissionId: '546d8b2a-a35b-4320-b255-1743dc3bda2d',
      turnId: 'cht-github',
      spaceId: 'spc-work',
      requestSummary: 'List open issues in example/disposable',
      review,
    })
    const calls: string[] = []
    const service = new GithubMcpService({
      rootDir: root,
      connections,
      vault,
      fetchFn: vi.fn(async (url) => {
        expect(String(url)).toBe('https://api.github.com/user')
        calls.push('account')
        return new Response(JSON.stringify({ login: 'reviewed-user' }), { status: 200 })
      }),
      install: async () => {
        calls.push('artifact')
        return '/reviewed/github-mcp-server'
      },
      createClient: () => ({
        start: async () => {
          calls.push('start')
        },
        discoverTools: async () => {
          calls.push('discover')
          return { name: 'list_issues', schemaSha256: review.toolSchemaSha256! }
        },
        listOpenIssues: async (owner, repo) => {
          calls.push(`read:${owner}/${repo}`)
          return {
            text: JSON.stringify({ issues: [{ number: 1, title: 'Disposable task' }] }),
            schemaSha256: review.toolSchemaSha256!,
          }
        },
        createIssue: async () => {
          throw new Error('Unexpected GitHub issue write')
        },
        stop: async () => {
          calls.push('stop')
        },
      }),
    })
    try {
      connections.beginAuthorization(attempt.id)
      await service.verifyAttempt(attempt.id, 'github_pat_' + 'x'.repeat(30))
      expect(calls).toEqual(['account', 'artifact', 'start', 'discover', 'stop'])
      await expect(
        service.listOpenIssues({
          spaceId: 'spc-work',
          repository: { owner: 'example', name: 'disposable' },
        }),
      ).rejects.toThrow('not granted')
      const verified = connections.attempt(attempt.id)!
      const grant = connections.grant(
        attempt.id,
        verified.verifiedAccount!,
        verified.verifiedScopes!,
      )
      const result = await service.listOpenIssues({
        spaceId: 'spc-work',
        repository: { owner: 'example', name: 'disposable' },
      })
      expect(result.text).toContain('Disposable task')
      expect(result.origin).toContain('untrusted:github-mcp')
      expect(calls).toContain('read:example/disposable')
      await expect(
        service.listOpenIssues({
          spaceId: 'spc-health',
          repository: { owner: 'example', name: 'disposable' },
        }),
      ).rejects.toThrow('not granted')
      connections.disableGrant(grant.id)
      await expect(
        service.listOpenIssues({
          spaceId: 'spc-work',
          repository: { owner: 'example', name: 'disposable' },
        }),
      ).rejects.toThrow('not granted')
    } finally {
      service.stop()
    }
  })

  it('aborts a running MCP read when its Space grant is disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-github-revoke-'))
    roots.push(root)
    const vault = SecretsVault.open(root, Buffer.from('test-only-vault-key'))
    const connections = new ServiceConnections(root)
    const review = githubConnectionReview('example', 'disposable')
    const attempt = connections.createAttempt({
      submissionId: '8cd578ef-7418-4d46-a034-d72474e5013b',
      turnId: 'cht-revoke',
      spaceId: 'spc-work',
      requestSummary: 'List open issues in example/disposable',
      review,
    })
    let enteredRead: (() => void) | undefined
    const reading = new Promise<void>((resolve) => (enteredRead = resolve))
    let aborted = false
    const service = new GithubMcpService({
      rootDir: root,
      connections,
      vault,
      fetchFn: async () =>
        new Response(JSON.stringify({ login: 'reviewed-user' }), { status: 200 }),
      install: async () => '/reviewed/github-mcp-server',
      createClient: () => ({
        start: async () => {},
        discoverTools: async () => ({
          name: 'list_issues',
          schemaSha256: review.toolSchemaSha256!,
        }),
        listOpenIssues: async (_owner, _repo, signal) => {
          enteredRead?.()
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              aborted = true
              reject(new Error('MCP read cancelled'))
            })
          })
        },
        createIssue: async () => {
          throw new Error('Unexpected GitHub issue write')
        },
        stop: async () => {},
      }),
    })
    try {
      connections.beginAuthorization(attempt.id)
      await service.verifyAttempt(attempt.id, 'github_pat_' + 'x'.repeat(30))
      const ready = connections.attempt(attempt.id)!
      const grant = connections.grant(attempt.id, ready.verifiedAccount!, ready.verifiedScopes!)
      const pending = service.listOpenIssues({
        spaceId: 'spc-work',
        repository: { owner: 'example', name: 'disposable' },
      })
      await reading
      connections.disableGrant(grant.id)
      await expect(pending).rejects.toThrow('MCP read cancelled')
      expect(aborted).toBe(true)
    } finally {
      service.stop()
    }
  })
})
