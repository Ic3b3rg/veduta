import { describe, expect, it } from 'vitest'
import {
  GatewayServerMessageSchema,
  PushPayloadSchema,
  PushSubscriptionSchema,
  SpaceWithSurfacesSchema,
} from './index.ts'

const validSubscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123def456',
  expirationTime: null,
  keys: {
    p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I3OJEMk',
    auth: 'tBHItJI5svbpez7KI4CCXg',
  },
}

describe('PushSubscriptionSchema', () => {
  it('accepts a real-looking browser subscription with a null expirationTime', () => {
    expect(PushSubscriptionSchema.parse(validSubscription)).toEqual(validSubscription)
  })

  it('rejects an http:// endpoint', () => {
    expect(
      PushSubscriptionSchema.safeParse({
        ...validSubscription,
        endpoint: 'http://fcm.googleapis.com/fcm/send/abc123def456',
      }).success,
    ).toBe(false)
  })

  it('rejects non-base64url keys', () => {
    expect(
      PushSubscriptionSchema.safeParse({
        ...validSubscription,
        keys: { ...validSubscription.keys, p256dh: `${validSubscription.keys.p256dh}+/=` },
      }).success,
    ).toBe(false)

    expect(
      PushSubscriptionSchema.safeParse({
        ...validSubscription,
        keys: { ...validSubscription.keys, auth: 'not valid base64url!!' },
      }).success,
    ).toBe(false)
  })
})

describe('PushPayloadSchema', () => {
  const validPayload = {
    title: 'New update',
    body: 'Something happened in your Space',
    url: '/app/space/health/surface/srf-groceries',
  }

  it('accepts a same-origin relative url', () => {
    expect(PushPayloadSchema.parse(validPayload)).toEqual(validPayload)
  })

  it('rejects a protocol-relative url', () => {
    expect(PushPayloadSchema.safeParse({ ...validPayload, url: '//evil.com/phish' }).success).toBe(
      false,
    )
  })

  it('rejects an absolute https:// url', () => {
    expect(
      PushPayloadSchema.safeParse({ ...validPayload, url: 'https://evil.com/phish' }).success,
    ).toBe(false)
  })

  it('rejects a backslash URL bypass ("new URL" treats \\ as /)', () => {
    expect(PushPayloadSchema.safeParse({ ...validPayload, url: '/\\evil.com/push' }).success).toBe(
      false,
    )
    expect(PushPayloadSchema.safeParse({ ...validPayload, url: '/a\\b' }).success).toBe(false)
  })

  it('rejects a url containing ASCII control characters', () => {
    expect(
      PushPayloadSchema.safeParse({ ...validPayload, url: '/app/space\nhealth' }).success,
    ).toBe(false)
    expect(
      PushPayloadSchema.safeParse({ ...validPayload, url: '/app/space\x00health' }).success,
    ).toBe(false)
  })
})

describe('Space attention (gateway protocol)', () => {
  it('parses a legacy cached snapshot Space without attention fields, defaulting to 0', () => {
    const legacy = {
      id: 'spc-health',
      slug: 'health',
      name: 'Health',
      surfaces: [],
    }

    const parsed = SpaceWithSurfacesSchema.parse(legacy)
    expect(parsed.attention).toBe(0)
    expect(parsed.attentionRevision).toBe(0)
  })

  it('round-trips a space.attention server frame', () => {
    const frame = {
      type: 'space.attention' as const,
      spaceId: 'spc-health',
      count: 2,
      revision: 5,
    }

    expect(GatewayServerMessageSchema.parse(frame)).toEqual(frame)
  })
})
