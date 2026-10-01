import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayServerMessage, PendingDecision } from '@veduta/protocol'
import { ChatTimeline } from './chat-timeline.ts'
import { ChatTimelineCoordinator } from './chat-timeline-coordinator.ts'
import { ServiceConnections } from './service-connections.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function harness() {
  const root = mkdtempSync(join(tmpdir(), 'veduta-chat-coordinator-'))
  roots.push(root)
  const timeline = new ChatTimeline(root)
  const frames: GatewayServerMessage[] = []
  const runTurn = vi.fn(async (event: { clientId: string; turnId?: string; text: string }) => {
    const frame: GatewayServerMessage = {
      type: 'chat.turn-end',
      turnId: event.turnId!,
      message: { role: 'assistant', text: `Reply: ${event.text}` },
    }
    frames.push(frame)
    coordinator.receive(frame)
  })
  const coordinator = new ChatTimelineCoordinator({
    timeline,
    hasSpace: (spaceId) => spaceId === 'spc-health' || spaceId === 'spc-work',
    runTurn,
    publish: vi.fn(),
  })
  return { root, timeline, coordinator, runTurn, frames }
}

describe('Chat timeline execution', () => {
  it('holds one reviewed service attempt before effects and resumes the original accepted turn once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-chat-service-'))
    roots.push(root)
    const timeline = new ChatTimeline(root)
    const services = new ServiceConnections(root)
    const runTurn = vi.fn(async (event: { turnId?: string }) => {
      coordinator.receive({
        type: 'chat.turn-end',
        turnId: event.turnId!,
        message: { role: 'assistant', text: 'One issue Surface was saved.' },
      })
    })
    const coordinator = new ChatTimelineCoordinator({
      timeline,
      serviceConnections: services,
      spaces: () => [{ id: 'spc-work', name: 'Work', slug: 'work' }],
      hasSpace: (id) => id === 'spc-work',
      runTurn,
      publish: vi.fn(),
    })
    const submission = {
      clientId: 'device-1',
      receivedAt: '2026-10-01T10:00:00.000Z',
      text: 'List open issues in example/disposable',
      spaceId: 'spc-work',
      submissionId: '20e15ad1-cf3c-4070-b976-3120d0c2926f',
    }
    const accepted = coordinator.submit(submission)
    await coordinator.idle()
    const attempt = services.attemptForTurn(accepted.turnId)!
    expect(attempt).toMatchObject({
      submissionId: submission.submissionId,
      spaceId: 'spc-work',
      state: 'reviewing',
    })
    expect(timeline.userEntry(accepted.turnId)?.turnState).toBe('waiting_connection')
    expect(timeline.page({ type: 'space', spaceId: 'spc-work' }).entries).toMatchObject([
      { kind: 'user' },
      { kind: 'connection', connectionAttemptId: attempt.id },
    ])
    expect(runTurn).not.toHaveBeenCalled()
    expect(coordinator.submit(submission).turnId).toBe(accepted.turnId)
    services.beginAuthorization(attempt.id)
    services.beginVerification(attempt.id)
    services.verified(attempt.id, {
      connectionId: 'svc-github-test',
      account: 'reviewed-user',
      scopes: attempt.review.scopes,
      mechanism: 'github-mcp-stdio',
      credentialRef: 'secret://vault/github-test',
    })
    expect(runTurn).not.toHaveBeenCalled()
    services.grant(attempt.id, 'reviewed-user', attempt.review.scopes)
    coordinator.resumeConnection(attempt.id)
    await coordinator.idle()
    expect(runTurn).toHaveBeenCalledTimes(1)
    expect(timeline.userEntry(accepted.turnId)?.turnState).toBe('completed')
    expect(services.attempt(attempt.id)?.continuation).toBe('completed')
    coordinator.resumeConnection(attempt.id)
    await coordinator.idle()
    expect(runTurn).toHaveBeenCalledTimes(1)
    timeline.close()
  })

  it('commits a user entry before dispatch and runs each same-scope submission once in order', async () => {
    const { timeline, coordinator, runTurn } = harness()
    const first = coordinator.submit({
      clientId: 'device-1',
      receivedAt: new Date().toISOString(),
      text: 'First',
      spaceId: 'spc-health',
      submissionId: '00000000-0000-4000-8000-000000000001',
    })
    const second = coordinator.submit({
      clientId: 'device-1',
      receivedAt: new Date().toISOString(),
      text: 'Second',
      spaceId: 'spc-health',
      submissionId: '00000000-0000-4000-8000-000000000002',
    })
    expect(timeline.page({ type: 'space', spaceId: 'spc-health' }).entries).toHaveLength(2)
    expect(
      coordinator.submit({
        clientId: 'device-1',
        receivedAt: new Date().toISOString(),
        text: 'First',
        spaceId: 'spc-health',
        submissionId: '00000000-0000-4000-8000-000000000001',
      }),
    ).toEqual(first)
    await coordinator.idle()
    expect(runTurn.mock.calls.map(([event]) => event.text)).toEqual(['First', 'Second'])
    expect(timeline.userEntry(first.turnId)?.turnState).toBe('completed')
    expect(timeline.userEntry(second.turnId)?.turnState).toBe('completed')
    timeline.close()
  })

  it('recovers accepted work once and leaves orphaned running work interrupted', async () => {
    const { root, timeline, coordinator } = harness()
    const scope = { type: 'global' as const }
    const orphan = timeline.accept({ submissionId: 'orphan', text: 'Maybe sent', scope })
    timeline.begin(orphan.turnId)
    const accepted = timeline.accept({ submissionId: 'accepted', text: 'Safe to run', scope })
    timeline.close()
    const reopened = new ChatTimeline(root)
    const runTurn = vi.fn(async () => {})
    const recovered = new ChatTimelineCoordinator({
      timeline: reopened,
      hasSpace: () => true,
      runTurn,
      publish: vi.fn(),
    })
    recovered.recover()
    await recovered.idle()
    expect(reopened.userEntry(orphan.turnId)?.turnState).toBe('interrupted')
    expect(reopened.userEntry(accepted.turnId)?.turnState).toBe('failed')
    expect(runTurn).toHaveBeenCalledTimes(1)
    coordinator.prepareStop()
    reopened.close()
  })

  it('keeps one Pending decision entry through turn completion and later outcome updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-chat-decision-'))
    roots.push(root)
    const timeline = new ChatTimeline(root)
    const decision: PendingDecision = {
      id: 'approval:effect-1',
      kind: 'approval',
      summary: 'Send the update',
      scope: { type: 'space', spaceId: 'spc-health' },
      allowedResolutions: ['approve', 'reject'],
      state: 'pending',
      createdAt: '2026-10-01T10:00:00.000Z',
    }
    const coordinator: ChatTimelineCoordinator = new ChatTimelineCoordinator({
      timeline,
      hasSpace: () => true,
      publish: vi.fn(),
      runTurn: async (event) => {
        const message = {
          role: 'assistant' as const,
          text: 'Awaiting your decision: Send the update.',
          pendingDecisions: [decision],
        }
        coordinator.receive({ type: 'chat.turn-replace', turnId: event.turnId!, message })
        coordinator.receive({ type: 'chat.turn-end', turnId: event.turnId!, message })
      },
    })
    const accepted = coordinator.submit({
      clientId: 'device-1',
      receivedAt: '2026-10-01T10:00:00.000Z',
      text: 'Send the update',
      spaceId: 'spc-health',
    })
    await coordinator.idle()
    expect(timeline.page({ type: 'space', spaceId: 'spc-health' }).entries).toMatchObject([
      { kind: 'user', turnId: accepted.turnId, turnState: 'completed' },
      {
        kind: 'decision',
        turnId: accepted.turnId,
        message: { pendingDecisions: [{ state: 'pending' }] },
      },
    ])
    const terminal: PendingDecision = {
      ...decision,
      state: 'terminal',
      outcome: 'executed',
      resolvedAt: '2026-10-01T10:01:00.000Z',
    }
    timeline.updateDecision(decision.id, 2, terminal)
    expect(timeline.page({ type: 'space', spaceId: 'spc-health' }).entries[1]).toMatchObject({
      kind: 'decision',
      revision: 2,
      message: { text: 'Executed: Send the update.' },
    })
    timeline.close()
  })

  it('attaches another client to the same running turn without resubmitting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-chat-reattach-'))
    roots.push(root)
    const timeline = new ChatTimeline(root)
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn(async () => held)
    const coordinator = new ChatTimelineCoordinator({
      timeline,
      hasSpace: () => true,
      runTurn,
      publish: vi.fn(),
    })
    const turn = coordinator.submit({
      clientId: 'device-1',
      receivedAt: '2026-10-01T10:00:00.000Z',
      text: 'Long task',
      spaceId: 'spc-health',
    })
    await vi.waitFor(() => expect(timeline.userEntry(turn.turnId)?.turnState).toBe('running'))
    expect(coordinator.subscribe('device-2', turn.turnId)).toEqual({
      type: 'space',
      spaceId: 'spc-health',
    })
    expect(coordinator.subscribersFor(turn.turnId)).toEqual(['device-2'])
    expect(runTurn).toHaveBeenCalledTimes(1)
    release()
    await coordinator.idle()
    expect(coordinator.subscribersFor(turn.turnId)).toEqual([])
    timeline.close()
  })
})
