import { describe, expect, it } from 'vitest'
import {
  runTrustParityScenario,
  TRUST_PARITY_APPROVAL_RESULT,
  TRUST_PARITY_UNTRUSTED_ORIGIN,
  type TrustParityOutcome,
} from './provider-trust-parity-fixture.ts'

function expectToolLifecycle(
  outcome: TrustParityOutcome,
  toolName: string,
  resultText: string,
  finalText: string,
): void {
  expect(outcome.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'tool-start', toolName }),
      expect.objectContaining({
        type: 'tool-result',
        toolName,
        content: resultText,
        isError: false,
      }),
      expect.objectContaining({ type: 'turn-end', text: finalText }),
    ]),
  )
  expect(outcome.sessionEntries).toEqual(
    expect.arrayContaining([
      {
        type: 'message',
        message: expect.objectContaining({ role: 'tool', toolName, content: resultText }),
      },
      {
        type: 'message',
        message: expect.objectContaining({ role: 'assistant', content: finalText }),
      },
    ]),
  )
}

describe('AgentRunner trust parity across Model connection methods (issue #74)', () => {
  it('executes one trusted allowlisted L1 action with equivalent public outcomes', async () => {
    const byok = await runTrustParityScenario('byok', 'allowlisted-l1')
    const subscription = await runTrustParityScenario('chatgpt-subscription', 'allowlisted-l1')

    expect(subscription.outcome).toEqual(byok.outcome)
    expect(subscription.subscriptionResponseIds).toEqual([0])
    expectToolLifecycle(
      subscription.outcome,
      'send_message',
      'Sent message to wife@example.com.',
      'Sent.',
    )
    expect(subscription.outcome.deliveriesBeforeResolution).toBe(1)
    expect(subscription.outcome.deliveriesAfterResolution).toBe(1)
    expect(subscription.outcome.card).toBeUndefined()
    expect(subscription.outcome.auditEntries).toHaveLength(2)
    expect(subscription.outcome.auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action.decision',
          toolName: 'send_message',
          decision: 'allowed',
          effectiveOrigin: 'trusted:user',
        }),
        expect.objectContaining({
          kind: 'action.outcome',
          toolName: 'send_message',
          outcome: 'executed',
        }),
      ]),
    )
  })

  it('grows live taint from an Untrusted Surface read before carding the next L1 call', async () => {
    const byok = await runTrustParityScenario('byok', 'tainted-l1')
    const subscription = await runTrustParityScenario('chatgpt-subscription', 'tainted-l1')

    expect(subscription.outcome).toEqual(byok.outcome)
    expect(subscription.subscriptionResponseIds).toEqual([0, 1])
    expectToolLifecycle(
      subscription.outcome,
      'send_message',
      TRUST_PARITY_APPROVAL_RESULT,
      'The outbound action awaits approval.',
    )
    expect(subscription.outcome.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool-start', toolName: 'read_surface' }),
        expect.objectContaining({ type: 'tool-result', toolName: 'read_surface' }),
        expect.objectContaining({
          type: 'turn-end',
          origins: expect.arrayContaining([TRUST_PARITY_UNTRUSTED_ORIGIN]),
        }),
      ]),
    )
    expect(subscription.outcome.sessionEntries).toEqual(
      expect.arrayContaining([
        {
          type: 'message',
          message: expect.objectContaining({
            role: 'tool',
            toolName: 'read_surface',
            origins: [TRUST_PARITY_UNTRUSTED_ORIGIN],
            origin: TRUST_PARITY_UNTRUSTED_ORIGIN,
          }),
        },
        {
          type: 'message',
          message: expect.objectContaining({
            role: 'tool',
            toolName: 'send_message',
            content: TRUST_PARITY_APPROVAL_RESULT,
            details: expect.objectContaining({
              surfaceId: expect.stringMatching('^srf-approval-'),
            }),
          }),
        },
      ]),
    )
    expect(subscription.outcome.readOrigins).toEqual([TRUST_PARITY_UNTRUSTED_ORIGIN])
    expect(subscription.outcome.deliveriesBeforeResolution).toBe(0)
    expect(subscription.outcome.deliveriesAfterResolution).toBe(1)
    expect(subscription.outcome.cardPresentAfterResolution).toBe(false)
    expect(subscription.outcome.card).toMatchObject({
      level: 'L1',
      provenance: { contentOrigin: 'trusted:system' },
    })
    expect(subscription.outcome.auditEntries).toHaveLength(3)
    expect(subscription.outcome.auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action.decision',
          toolName: 'send_message',
          decision: 'card',
          effectiveOrigin: TRUST_PARITY_UNTRUSTED_ORIGIN,
          originChain: expect.arrayContaining([TRUST_PARITY_UNTRUSTED_ORIGIN]),
        }),
        expect.objectContaining({
          kind: 'approval.decided',
          toolName: 'send_message',
          decision: 'approved',
          originChain: expect.arrayContaining([TRUST_PARITY_UNTRUSTED_ORIGIN]),
        }),
        expect.objectContaining({
          kind: 'action.outcome',
          toolName: 'send_message',
          outcome: 'executed',
        }),
      ]),
    )
    expect(subscription.outcome.eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'surface.create', origin: 'trusted:system' }),
        expect.objectContaining({
          type: 'outbound.delivery',
          origin: TRUST_PARITY_UNTRUSTED_ORIGIN,
        }),
        expect.objectContaining({
          type: 'approval.outcome',
          origin: 'trusted:system',
          payload: expect.objectContaining({ outcome: 'executed' }),
        }),
      ]),
    )
  })

  it('cards and rejects an L2 action even with a planted allowlist in a trusted turn', async () => {
    const byok = await runTrustParityScenario('byok', 'l2')
    const subscription = await runTrustParityScenario('chatgpt-subscription', 'l2')

    expect(subscription.outcome).toEqual(byok.outcome)
    expect(subscription.subscriptionResponseIds).toEqual([0])
    expectToolLifecycle(
      subscription.outcome,
      'transfer_funds',
      TRUST_PARITY_APPROVAL_RESULT,
      'Approval requested.',
    )
    expect(subscription.outcome.deliveriesBeforeResolution).toBe(0)
    expect(subscription.outcome.deliveriesAfterResolution).toBe(0)
    expect(subscription.outcome.cardPresentAfterResolution).toBe(false)
    expect(subscription.outcome.card).toMatchObject({
      level: 'L2',
      provenance: { contentOrigin: 'trusted:system' },
    })
    expect(subscription.outcome.auditEntries).toHaveLength(2)
    expect(subscription.outcome.auditEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'action.decision',
          toolName: 'transfer_funds',
          level: 'L2',
          decision: 'card',
          effectiveOrigin: 'trusted:user',
        }),
        expect.objectContaining({
          kind: 'action.outcome',
          toolName: 'transfer_funds',
          level: 'L2',
          outcome: 'rejected',
          approvedBy: 'trusted:user',
        }),
      ]),
    )
    expect(subscription.outcome.eventLog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'approval.outcome',
          origin: 'trusted:system',
          payload: expect.objectContaining({ outcome: 'rejected' }),
        }),
      ]),
    )
  })
})
