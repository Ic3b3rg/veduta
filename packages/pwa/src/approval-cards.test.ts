import type { ApprovalCard } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { dismissCardsForSurface } from './approval-cards.tsx'

function testCard(id: string, surfaceId: string): ApprovalCard {
  return {
    id,
    level: 'L1',
    title: `Send message via ${id}`,
    body: 'Send the drafted message?',
    actionLabel: 'Approve',
    createdAt: '2026-07-10T12:00:00.000Z',
    surfaceId,
    expiresAt: '2026-07-10T12:30:00.000Z',
  }
}

describe('dismissCardsForSurface', () => {
  it('removes only the chip whose card Surface matches', () => {
    const cards = [testCard('apr-1', 'srf-card-1'), testCard('apr-2', 'srf-card-2')]

    expect(dismissCardsForSurface(cards, 'srf-card-1')).toEqual([cards[1]])
  })

  it('leaves the list unchanged when no chip matches', () => {
    const cards = [testCard('apr-1', 'srf-card-1')]

    expect(dismissCardsForSurface(cards, 'srf-unrelated')).toEqual(cards)
  })
})
