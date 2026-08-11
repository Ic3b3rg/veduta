import { describe, expect, it, vi } from 'vitest'
import { SerializedWorkQueue } from './serialized-work-queue.ts'

describe('SerializedWorkQueue', () => {
  it('runs work in order and continues after a reported failure', async () => {
    const calls: string[] = []
    const onError = vi.fn()
    const queue = new SerializedWorkQueue(onError)

    queue.enqueue(async () => {
      calls.push('first')
      throw new Error('failed')
    })
    queue.enqueue(async () => {
      calls.push('second')
    })
    await queue.flush()

    expect(calls).toEqual(['first', 'second'])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'failed' }))
  })
})
