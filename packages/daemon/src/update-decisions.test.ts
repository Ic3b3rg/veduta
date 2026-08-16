import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateResult } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { untrustedOrigin } from './taint.ts'
import { UpdateDecisionStore } from './update-decisions.ts'

const roots: string[] = []
const now = () => new Date('2026-08-16T08:00:00.000Z')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('UpdateDecisionStore', () => {
  it('persists verified offers, supersedes pending offers, and never resurrects a terminal version', () => {
    const stateDir = tempRoot()
    const decisions = new UpdateDecisionStore({ stateDir, now })
    decisions.recordVerifiedOffer(available('1.1.0'), now().toISOString())
    decisions.recordVerifiedOffer(available('1.2.0'), now().toISOString())

    expect(decisions.get('1.1.0')).toMatchObject({ status: 'stale' })
    expect(decisions.get('1.2.0')).toMatchObject({ status: 'pending' })

    decisions.recordVerifiedOffer(available('1.1.0'), now().toISOString())

    expect(decisions.get('1.1.0')).toMatchObject({ status: 'stale' })
    expect(decisions.get('1.2.0')).toMatchObject({ status: 'stale' })

    const reopened = new UpdateDecisionStore({ stateDir, now })
    expect(reopened.list()).toEqual(decisions.list())
  })

  it('recovers a resolving claim with no updater handoff as a durable failure', () => {
    const stateDir = tempRoot()
    const decisions = new UpdateDecisionStore({ stateDir, now })
    decisions.recordVerifiedOffer(available('1.1.0'), now().toISOString())
    decisions.claim('1.1.0', 'trusted:user', now().toISOString())

    const recovered = new UpdateDecisionStore({ stateDir, now })
    expect(recovered.get('1.1.0')).toMatchObject({
      status: 'failed',
      resolvedBy: 'trusted:user',
      outcomeDetail: 'the update request did not reach the updater',
    })
    expect(new UpdateDecisionStore({ stateDir, now }).get('1.1.0')).toEqual(recovered.get('1.1.0'))
  })

  it('records the updater result and preserves its outcome provenance', () => {
    const stateDir = tempRoot()
    const decisions = new UpdateDecisionStore({ stateDir, now })
    const result: UpdateResult = {
      id: 'result-1',
      outcome: 'rolled-back',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      reason: 'hostile <<<reason>>>',
      finishedAt: now().toISOString(),
    }
    const origin = untrustedOrigin('update-feed')

    expect(decisions.recordResult(result, origin)).toMatchObject({
      status: 'rolled-back',
      resolvedBy: 'trusted:user',
      outcomeDetail: 'hostile <<<reason>>>',
      outcomeOrigin: origin,
    })
  })
})

function available(version: string) {
  return { version, notes: 'Verified release', migratesData: false }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'veduta-update-decisions-'))
  roots.push(root)
  return root
}
