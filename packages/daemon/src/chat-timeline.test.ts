import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PENDING_DECISION_FALLBACK_FEEDBACK,
  type ChatTimelineEntry,
  type PendingDecision,
} from '@veduta/protocol'
import { ChatTimeline } from './chat-timeline.ts'

const roots: string[] = []

function timeline(): { rootDir: string; store: ChatTimeline } {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-chat-timeline-'))
  roots.push(rootDir)
  return { rootDir, store: new ChatTimeline(rootDir) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Gateway Chat timeline', () => {
  it.each([
    {
      name: 'projected',
      text: 'Awaiting your decision: Create Space “Sviluppo”.',
      expectedText: '',
    },
    { name: 'identity-only', text: PENDING_DECISION_FALLBACK_FEEDBACK, expectedText: '' },
    {
      name: 'useful prose',
      text: 'The issue list is ready.',
      expectedText: 'The issue list is ready.',
    },
    {
      name: 'mixed confirmed write',
      text: 'Awaiting your decision: Create Space “Sviluppo”.\n\nRemembered 1 fact.',
      expectedText: 'Remembered 1 fact.',
    },
    {
      name: 'mixed failed write',
      text: 'Awaiting your decision: Create Space “Sviluppo”.\n\nA Surface change was not saved: conflicting revision.',
      expectedText: 'A Surface change was not saved: conflicting revision.',
    },
  ])(
    'recovers historical $name decision copies without losing result content or entry identity',
    ({ name, text, expectedText }) => {
      const { rootDir, store } = timeline()
      const scope = { type: 'global' as const }
      const pending: PendingDecision = {
        id: 'space-proposal:space-proposal-sviluppo',
        kind: 'space-proposal',
        summary: 'Create Space “Sviluppo”',
        scope,
        allowedResolutions: ['accept', 'reject'],
        state: 'pending',
        createdAt: '2026-10-21T10:00:00.000Z',
      }
      const target = {
        spaceId: 'spc-sviluppo',
        spaceSlug: 'sviluppo',
        spaceName: 'Sviluppo',
        surfaceId: 'srf-bugs',
        surfaceTitle: 'Open bugs',
      }
      const turn = store.accept({
        submissionId: 'legacy-result',
        scope,
        text: 'Track GitHub issues in Sviluppo',
      })
      store.begin(turn.turnId)
      const canonical = store.addDecision(turn.turnId, pending)
      store.updateDecision(pending.id, 1, {
        ...pending,
        state: 'terminal',
        outcome: 'accepted',
        resolvedAt: '2026-10-21T10:01:00.000Z',
      })
      const legacy = store.complete(turn.turnId, {
        role: 'assistant',
        text,
        targets: [target],
        ...(name === 'identity-only'
          ? { pendingDecisionIds: [pending.id] }
          : { pendingDecisions: [pending] }),
      })
      store.close()
      const restored = new ChatTimeline(rootDir)
      let recovered: ChatTimelineEntry | undefined
      try {
        const entries = restored.page(scope).entries
        expect(entries).toHaveLength(3)
        expect(
          entries.find((entry) => entry.id === canonical?.id)?.message.pendingDecisions,
        ).toMatchObject([{ id: pending.id, state: 'terminal', outcome: 'accepted' }])
        recovered = entries.find((entry) => entry.id === legacy?.id)
        expect(recovered).toMatchObject({
          id: legacy?.id,
          turnId: turn.turnId,
          position: legacy?.position,
          revision: (legacy?.revision ?? 0) + 1,
          message: { role: 'assistant', text: expectedText, targets: [target] },
        })
        expect(recovered?.message.pendingDecisions).toBeUndefined()
        expect(recovered?.message.pendingDecisionIds).toBeUndefined()
        const latest = restored.page(scope, undefined, 1)
        expect(latest.entries[0]?.id).toBe(legacy?.id)
        expect(restored.page(scope, latest.nextBefore, 1).entries[0]?.id).toBe(canonical?.id)
      } finally {
        restored.close()
      }
      const restarted = new ChatTimeline(rootDir)
      try {
        expect(restarted.page(scope).entries.find((entry) => entry.id === legacy?.id)).toEqual(
          recovered,
        )
      } finally {
        restarted.close()
      }
    },
  )

  it.each(['missing', 'other-scope'] as const)(
    'preserves unresolved result references when the canonical decision is $0',
    (location) => {
      const { rootDir, store } = timeline()
      const scope = { type: 'global' as const }
      const pending: PendingDecision = {
        id: 'space-proposal:space-proposal-unresolved',
        kind: 'space-proposal',
        summary: 'Create Space “Sviluppo”',
        scope,
        allowedResolutions: ['accept', 'reject'],
        state: 'pending',
        createdAt: '2026-10-21T10:00:00.000Z',
      }
      if (location === 'other-scope') {
        const other = store.accept({
          submissionId: 'other-scope',
          scope: { type: 'space', spaceId: 'spc-other' },
          text: 'A separate Chat scope',
        })
        store.addDecision(other.turnId, pending)
        store.completeWithDecisions(other.turnId)
      }
      const turn = store.accept({
        submissionId: 'unresolved-result',
        scope,
        text: 'Check the proposal',
      })
      const original = store.complete(turn.turnId, {
        role: 'assistant',
        text: 'Awaiting your decision: Create Space “Sviluppo”.',
        pendingDecisions: [pending],
        targets: [{ spaceId: 'spc-bugs', spaceSlug: 'bugs', spaceName: 'bugs' }],
      })
      store.close()
      const restored = new ChatTimeline(rootDir)
      try {
        expect(restored.page(scope).entries.find((entry) => entry.id === original?.id)).toEqual(
          original,
        )
      } finally {
        restored.close()
      }
    },
  )

  it('commits a focused-Space submission once and returns the same completed entries after restart', () => {
    const { rootDir, store } = timeline()
    const scope = { type: 'space' as const, spaceId: 'spc-health' }
    const accepted = store.accept({ submissionId: 'sub-1', scope, text: 'How is my plan?' })
    expect(store.accept({ submissionId: 'sub-1', scope, text: 'How is my plan?' })).toEqual(
      accepted,
    )
    expect(store.page(scope).entries).toMatchObject([
      {
        id: accepted.entryId,
        turnId: accepted.turnId,
        kind: 'user',
        message: { text: 'How is my plan?' },
      },
    ])

    expect(store.begin(accepted.turnId)).toBe(true)
    store.complete(accepted.turnId, { role: 'assistant', text: 'Your plan is on track.' })
    store.close()

    const reopened = new ChatTimeline(rootDir)
    expect(reopened.page(scope).entries).toMatchObject([
      { id: accepted.entryId, kind: 'user', turnState: 'completed' },
      { kind: 'assistant', message: { role: 'assistant', text: 'Your plan is on track.' } },
    ])
    expect(
      reopened.accept({ submissionId: 'sub-1', scope, text: 'How is my plan?' }),
    ).toMatchObject({
      submissionId: accepted.submissionId,
      turnId: accepted.turnId,
      entryId: accepted.entryId,
      state: 'completed',
    })
    reopened.close()
  })

  it('keeps global and Space pages separate and reaches entries older than 80', () => {
    const { store } = timeline()
    const health = { type: 'space' as const, spaceId: 'spc-health' }
    const work = { type: 'space' as const, spaceId: 'spc-work' }
    const global = { type: 'global' as const }
    for (let index = 0; index < 45; index += 1) {
      const turn = store.accept({
        submissionId: `health-${index}`,
        scope: health,
        text: `Health ${index}`,
      })
      store.begin(turn.turnId)
      store.complete(turn.turnId, { role: 'assistant', text: `Reply ${index}` })
    }
    store.accept({ submissionId: 'work-1', scope: work, text: 'Work only' })
    store.accept({ submissionId: 'global-1', scope: global, text: 'Global only' })

    let before: string | undefined
    const seen: string[] = []
    do {
      const page = store.page(health, before, 17)
      seen.unshift(...page.entries.map((entry) => entry.message.text))
      before = page.nextBefore
    } while (before)
    expect(seen).toHaveLength(90)
    expect(seen[0]).toBe('Health 0')
    expect(seen.at(-1)).toBe('Reply 44')
    expect(new Set(seen).size).toBe(90)
    expect(store.page(work).entries.map((entry) => entry.message.text)).toEqual(['Work only'])
    expect(store.page(global).entries.map((entry) => entry.message.text)).toEqual(['Global only'])
    expect(() => store.page(work, store.page(health).entries[0]?.cursor)).toThrow(
      'Invalid Chat timeline cursor',
    )
    store.close()
  })

  it('interrupts only running work at restart and requires a linked explicit Retry', () => {
    const { rootDir, store } = timeline()
    const scope = { type: 'space' as const, spaceId: 'spc-health' }
    const running = store.accept({ submissionId: 'running', scope, text: 'Check mail' })
    const accepted = store.accept({ submissionId: 'accepted', scope, text: 'Check calendar' })
    store.begin(running.turnId)
    store.close()

    const reopened = new ChatTimeline(rootDir)
    expect(reopened.recoverInterrupted()).toMatchObject([
      { kind: 'error', message: { text: expect.stringContaining('Completion is unknown') } },
    ])
    expect(reopened.accepted()).toMatchObject([{ turnId: accepted.turnId, state: 'accepted' }])
    expect(reopened.page(scope).entries[0]).toMatchObject({
      turnId: running.turnId,
      turnState: 'interrupted',
    })
    expect(() =>
      reopened.accept({
        submissionId: 'bad-retry',
        scope,
        text: 'Check calendar',
        retryOf: accepted.turnId,
      }),
    ).toThrow('Only an interrupted Chat turn can be retried')
    const retried = reopened.accept({
      submissionId: 'retry-1',
      scope,
      text: 'Check mail',
      retryOf: running.turnId,
    })
    expect(retried.turnId).not.toBe(running.turnId)
    expect(reopened.page(scope).entries.at(-1)).toMatchObject({
      turnId: retried.turnId,
      retryOf: running.turnId,
    })
    expect(
      reopened.accept({
        submissionId: 'retry-1',
        scope,
        text: 'Check mail',
        retryOf: running.turnId,
      }).turnId,
    ).toBe(retried.turnId)
    reopened.close()
  })

  it('rejects a ninth nonterminal submission in one scope while another scope remains available', () => {
    const { store } = timeline()
    const scope = { type: 'space' as const, spaceId: 'spc-health' }
    for (let index = 0; index < 8; index += 1)
      store.accept({ submissionId: `sub-${index}`, scope, text: `Request ${index}` })
    expect(() => store.accept({ submissionId: 'sub-9', scope, text: 'Too many' })).toThrow(
      'eight pending turns',
    )
    expect(store.page(scope).entries).toHaveLength(8)
    expect(
      store.accept({
        submissionId: 'work',
        scope: { type: 'space', spaceId: 'spc-work' },
        text: 'Work',
      }).state,
    ).toBe('accepted')
    store.close()
  })

  it('updates one durable Pending decision entry in place without regressing its revision', () => {
    const { rootDir, store } = timeline()
    const scope = { type: 'space' as const, spaceId: 'spc-health' }
    const turn = store.accept({ submissionId: 'decision-turn', scope, text: 'Send the update' })
    store.begin(turn.turnId)
    const pending: PendingDecision = {
      id: 'approval:effect-1',
      kind: 'approval',
      summary: 'Send the update',
      scope,
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      createdAt: '2026-10-01T10:00:00.000Z',
    }
    const first = store.addDecision(turn.turnId, pending)
    expect(first?.kind).toBe('decision')
    expect(first?.message.pendingDecisions?.[0]?.state).toBe('pending')
    expect(store.addDecision(turn.turnId, pending)?.id).toBe(first?.id)
    const resolving: PendingDecision = {
      ...pending,
      state: 'resolving',
      decisionAt: '2026-10-01T10:01:00.000Z',
      resolvedBy: 'trusted:user',
    }
    const second = store.updateDecision(pending.id, 7, resolving)
    expect(second).toMatchObject({ id: first?.id, revision: 2 })
    expect(store.updateDecision(pending.id, 6, pending)).toBeUndefined()
    const terminal: PendingDecision = {
      ...resolving,
      state: 'terminal',
      outcome: 'executed',
      resolvedAt: '2026-10-01T10:02:00.000Z',
    }
    expect(store.updateDecision(pending.id, 8, terminal)).toMatchObject({
      id: first?.id,
      revision: 3,
    })
    store.close()
    const reopened = new ChatTimeline(rootDir)
    expect(reopened.page(scope).entries.filter((entry) => entry.kind === 'decision')).toMatchObject(
      [{ id: first?.id, revision: 3, message: { pendingDecisions: [{ state: 'terminal' }] } }],
    )
    reopened.close()
  })

  it('replaces an unprojected decision placeholder at the same stable entry identity', () => {
    const { store } = timeline()
    const scope = { type: 'global' as const }
    const turn = store.accept({ submissionId: 'unprojected', scope, text: 'Review the request' })
    const placeholder = store.addUnprojectedDecision(turn.turnId, 'approval:effect-2')
    expect(placeholder?.message.pendingDecisionIds).toEqual(['approval:effect-2'])
    const decision: PendingDecision = {
      id: 'approval:effect-2',
      kind: 'approval',
      summary: 'Review the request',
      scope,
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      createdAt: '2026-10-01T10:00:00.000Z',
    }
    const updated = store.updateDecision(decision.id, 4, decision)
    expect(updated?.id).toBe(placeholder?.id)
    expect(updated?.revision).toBe(2)
    expect(store.page(scope).entries).toHaveLength(2)
    store.close()
  })
})
