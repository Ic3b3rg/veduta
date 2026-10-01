import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ServiceConnections } from './service-connections.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'veduta-service-connections-'))
  roots.push(root)
  const events: { spaceId: string; summary: string }[] = []
  const connections = new ServiceConnections(root, {
    onGrantChanged: (spaceId, summary) => events.push({ spaceId, summary }),
  })
  const input = {
    submissionId: 'a753a42c-dac3-4c5c-a331-c1a70e335738',
    turnId: 'cht-original',
    spaceId: 'spc-work',
    requestSummary: 'List open issues in example/disposable',
    review: {
      service: 'github' as const,
      scopes: ['GitHub Issues: read in example/disposable'],
      actions: ['list_issues'],
      executionHost: 'Gateway local stdio',
      repository: { owner: 'example', name: 'disposable' },
    },
  }
  return { root, events, connections, input }
}

describe('one durable Service connection lifecycle', () => {
  it('keeps an existing Space grant when the same Gmail account is verified for a second Space', () => {
    const { connections } = setup()
    const review = {
      service: 'gmail' as const,
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      actions: ['search_mailbox'],
      executionHost: 'Gateway native HTTPS',
    }
    const prepare = (submissionId: string, turnId: string, spaceId: string) => {
      const attempt = connections.createAttempt({
        submissionId,
        turnId,
        spaceId,
        requestSummary: 'Find unread mail',
        review,
      })
      connections.beginAuthorization(attempt.id)
      connections.beginVerification(attempt.id)
      return attempt
    }
    const first = prepare('2d2632a2-d471-4306-bca5-7a909248a7f7', 'cht-first', 'spc-work')
    const account = {
      connectionId: 'gmail-account-1',
      account: 'user@example.com',
      scopes: review.scopes,
      mechanism: 'gmail-oauth' as const,
    }
    connections.verified(first.id, account)
    const workGrant = connections.grant(first.id, account.account, review.scopes)
    const second = prepare('1c97f0ef-848b-498e-9770-d14c4e84cf08', 'cht-second', 'spc-health')
    connections.verified(second.id, account)
    const healthGrant = connections.grant(second.id, account.account, review.scopes)
    expect(healthGrant.id).not.toBe(workGrant.id)
    expect(
      connections.eligible({ spaceId: 'spc-work', service: 'gmail', action: 'search_mailbox' })
        ?.grant.id,
    ).toBe(workGrant.id)
    expect(
      connections.eligible({ spaceId: 'spc-health', service: 'gmail', action: 'search_mailbox' })
        ?.grant.id,
    ).toBe(healthGrant.id)
    const reconnect = prepare('698a6e15-c3ad-43ae-abd4-8216b4fdb128', 'cht-reconnect', 'spc-work')
    connections.verified(reconnect.id, { ...account, rotateAuthorization: true })
    expect(
      connections.eligible({ spaceId: 'spc-work', service: 'gmail', action: 'search_mailbox' }),
    ).toBeUndefined()
    expect(
      connections.eligible({ spaceId: 'spc-health', service: 'gmail', action: 'search_mailbox' }),
    ).toBeUndefined()
  })

  it('deduplicates the accepted Chat identity, separates verification from Space grant, and claims once', () => {
    const { root, events, connections, input } = setup()
    const attempt = connections.createAttempt(input)
    expect(connections.createAttempt(input).id).toBe(attempt.id)
    expect(() => connections.createAttempt({ ...input, spaceId: 'spc-health' })).toThrow(
      'identity was reused',
    )
    connections.beginAuthorization(attempt.id)
    connections.beginVerification(attempt.id)
    connections.verified(attempt.id, {
      connectionId: 'svc-github-1',
      account: 'reviewed-user',
      scopes: input.review.scopes,
      mechanism: 'github-mcp-stdio',
      credentialRef: 'secret://vault/github-mcp-test',
    })
    expect(connections.claimContinuation(attempt.id)).toBe(false)
    expect(
      connections.eligible({
        spaceId: 'spc-work',
        service: 'github',
        action: 'list_issues',
        repository: input.review.repository,
      }),
    ).toBeUndefined()
    expect(() => connections.grant(attempt.id, 'different-user', input.review.scopes)).toThrow(
      'Account or scopes changed',
    )
    const grant = connections.grant(attempt.id, 'reviewed-user', input.review.scopes)
    expect(connections.grant(attempt.id, 'reviewed-user', input.review.scopes).id).toBe(grant.id)
    expect(events).toEqual([{ spaceId: 'spc-work', summary: 'github capability granted' }])
    expect(connections.claimContinuation(attempt.id)).toBe(true)
    expect(connections.claimContinuation(attempt.id)).toBe(false)
    expect(
      connections.eligible({
        spaceId: 'spc-health',
        service: 'github',
        action: 'list_issues',
        repository: input.review.repository,
      }),
    ).toBeUndefined()
    expect(
      connections.eligible({
        spaceId: 'spc-work',
        service: 'github',
        action: 'list_issues',
        repository: { owner: 'example', name: 'other' },
      }),
    ).toBeUndefined()
    expect(readFileSync(join(root, 'service-connections.json'), 'utf8')).not.toContain('test-token')
    const restarted = new ServiceConnections(root)
    expect(restarted.attempt(attempt.id)?.continuation).toBe('claimed')
    expect(restarted.claimContinuation(attempt.id)).toBe(false)
    expect(restarted.snapshot().connections[0]).not.toHaveProperty('credentialRef')
    restarted.disableGrant(grant.id)
    expect(
      restarted.eligible({
        spaceId: 'spc-work',
        service: 'github',
        action: 'list_issues',
        repository: input.review.repository,
      }),
    ).toBeUndefined()
  })

  it('recovers interrupted authorization without granting or running the request', () => {
    const { root, connections, input } = setup()
    const attempt = connections.createAttempt(input)
    connections.beginAuthorization(attempt.id)
    const restarted = new ServiceConnections(root)
    expect(restarted.attempt(attempt.id)).toMatchObject({
      state: 'needs_reconnect',
      continuation: 'unclaimed',
    })
    expect(restarted.snapshot().grants).toEqual([])
    expect(restarted.retryReview(attempt.id).state).toBe('reviewing')
    expect(restarted.cancel(attempt.id).state).toBe('cancelled')
    expect(restarted.snapshot().grants).toEqual([])
  })
})
