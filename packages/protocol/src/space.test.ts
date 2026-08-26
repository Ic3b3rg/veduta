import { describe, expect, it } from 'vitest'
import { SYSTEM_SPACE_ID } from './index.ts'

describe('canonical System Space identity', () => {
  it('exports the one engine-owned identity through the shared protocol', () => {
    expect(SYSTEM_SPACE_ID).toBe('spc-system')
  })
})
