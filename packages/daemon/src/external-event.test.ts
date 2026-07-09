import { describe, expect, it } from 'vitest'
import { ExternalEventSchema } from './external-event.ts'

describe('ExternalEventSchema', () => {
  it('accepts a normalized email event with fetchRef and headers', () => {
    const parsed = ExternalEventSchema.parse({
      source: 'gmail',
      kind: 'email',
      externalId: 'm1',
      type: 'message.received',
      sender: 'anna@example.com',
      subject: 'ciao',
      headers: { 'list-unsubscribe': '<mailto:u@x>' },
      occurredAt: '2026-07-09T10:00:00.000Z',
      fetchRef: { provider: 'gmail', id: 'm1' },
    })
    expect(parsed.fetchRef).toEqual({ provider: 'gmail', id: 'm1' })
  })

  it('rejects events without an identity or type: discarded, never interpreted', () => {
    expect(
      ExternalEventSchema.safeParse({ source: 'mail', kind: 'email', type: 'x' }).success,
    ).toBe(false)
    expect(
      ExternalEventSchema.safeParse({ source: 'mail', kind: 'email', externalId: 'a' }).success,
    ).toBe(false)
    expect(
      ExternalEventSchema.safeParse({
        source: 'mail',
        kind: 'postcard',
        externalId: 'a',
        type: 'x',
      }).success,
    ).toBe(false)
  })
})
