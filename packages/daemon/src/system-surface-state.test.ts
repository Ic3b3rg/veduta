import type { JsonValue } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { statePatchOperations } from './system-surface-state.ts'

describe('statePatchOperations', () => {
  it('builds add and replace operations while leaving equal JSON values alone', () => {
    const current: Record<string, JsonValue> = {
      devices: [{ name: 'Phone', linked: '2026-08-26' }],
      status: 'Stale',
    }
    const next: Record<string, JsonValue> = {
      devices: [{ name: 'Phone', linked: '2026-08-26' }],
      status: 'Current',
      lastSuccessfulAt: '2026-08-26T10:00:00.000Z',
    }

    expect(statePatchOperations(current, next)).toEqual([
      {
        target: 'state',
        op: 'replace',
        path: '/status',
        value: 'Current',
      },
      {
        target: 'state',
        op: 'add',
        path: '/lastSuccessfulAt',
        value: '2026-08-26T10:00:00.000Z',
      },
    ])
  })

  it('omits configured keys from the generated operations', () => {
    expect(
      statePatchOperations(
        { status: 'Current', lastSuccessfulAt: '2026-08-26T10:00:00.000Z' },
        { status: 'Stale', lastSuccessfulAt: '2026-08-26T10:05:00.000Z' },
        ['lastSuccessfulAt'],
      ),
    ).toEqual([
      {
        target: 'state',
        op: 'replace',
        path: '/status',
        value: 'Stale',
      },
    ])
  })
})
