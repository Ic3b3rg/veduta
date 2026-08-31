import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SurfaceSchema, type Surface } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { Store, SurfaceActionError, type FastMutationNotice } from './store.ts'

const now = () => new Date('2026-09-01T08:00:00.000Z')

describe('atomic Form actions', () => {
  it('commits every text field in one mutation and deduplicates a persisted retry', async () => {
    const rootDir = await tempRoot()
    const first = new Store({ rootDir, now })
    first.createSurface(profileSurface(), 'agent')
    const cursorBeforeSubmit = first.latestSurfaceCursor()
    const notices: FastMutationNotice[] = []
    first.onFastMutation((notice) => notices.push(notice))

    const invocation = {
      nodeId: 'profile-form',
      name: 'submit',
      payload: { value: { displayName: 'Grace', bio: 'Compiler pioneer' } },
      idempotencyKey: 'profile-submit-grace',
    }
    const committed = first.invokeSurfaceAction('srf-profile', invocation)

    expect(committed.path).toBe('fast')
    if (committed.path !== 'fast') throw new Error('expected fast Form action')
    expect(committed.mutation).toMatchObject({
      duplicate: false,
      surface: {
        state: { displayName: 'Grace', bio: 'Compiler pioneer' },
      },
      event: {
        patch: {
          operations: [
            { target: 'state', op: 'replace', path: '/displayName', value: 'Grace' },
            { target: 'state', op: 'replace', path: '/bio', value: 'Compiler pioneer' },
          ],
        },
      },
    })
    expect(first.surfaceEventsAfter(cursorBeforeSubmit)).toHaveLength(1)
    expect(first.eventLog('spc-health').filter((event) => event.type === 'fast_path')).toHaveLength(
      1,
    )
    expect(notices.map(({ stateKey, value }) => [stateKey, value])).toEqual([
      ['displayName', 'Grace'],
      ['bio', 'Compiler pioneer'],
    ])
    expect(new Set(notices.map(({ mutation }) => mutation.event.cursor))).toEqual(
      new Set([committed.mutation.event.cursor]),
    )
    first.close()

    const restarted = new Store({ rootDir, now })
    const replayed = restarted.invokeSurfaceAction('srf-profile', invocation)

    expect(replayed.path).toBe('fast')
    if (replayed.path !== 'fast') throw new Error('expected fast Form replay')
    expect(replayed.mutation.duplicate).toBe(true)
    expect(restarted.getSurface('srf-profile')?.state).toEqual({
      displayName: 'Grace',
      bio: 'Compiler pioneer',
    })
    expect(
      restarted.eventLog('spc-health').filter((event) => event.type === 'fast_path'),
    ).toHaveLength(1)
  })

  it.each([
    { value: { displayName: 'Grace' } },
    { value: { displayName: 'Grace', bio: 'Compiler pioneer', nickname: 'Amazing Grace' } },
    { value: { displayName: 42, bio: 'Compiler pioneer' } },
    {},
  ])('rejects an invalid or incomplete payload without any durable change %#', async (payload) => {
    const store = new Store({ rootDir: await tempRoot(), now })
    store.createSurface(profileSurface(), 'agent')
    const cursorBeforeSubmit = store.latestSurfaceCursor()
    const stateBeforeSubmit = store.getSurface('srf-profile')?.state

    try {
      store.invokeSurfaceAction('srf-profile', {
        nodeId: 'profile-form',
        name: 'submit',
        payload,
      })
      throw new Error('expected invalid Form payload to be rejected')
    } catch (error) {
      expect(error).toBeInstanceOf(SurfaceActionError)
      if (!(error instanceof SurfaceActionError)) throw error
      expect(error.code).toBe('invalid_payload')
    }

    expect(store.getSurface('srf-profile')?.state).toEqual(stateBeforeSubmit)
    expect(store.surfaceEventsAfter(cursorBeforeSubmit)).toEqual([])
    expect(store.eventLog('spc-health').filter((event) => event.type === 'fast_path')).toEqual([])
  })
})

function profileSurface(): Surface {
  return SurfaceSchema.parse({
    id: 'srf-profile',
    spaceId: 'spc-health',
    title: 'Profile',
    tree: {
      id: 'profile-form',
      type: 'Form',
      props: { label: 'Profile details', submitLabel: 'Save profile' },
      actions: [{ name: 'submit', path: 'fast', stateKeys: ['displayName', 'bio'] }],
      children: [
        {
          id: 'display-name',
          type: 'Input',
          binding: 'displayName',
          props: { label: 'Display name' },
        },
        {
          id: 'bio',
          type: 'Textarea',
          binding: 'bio',
          props: { label: 'Biography' },
        },
      ],
    },
    state: { displayName: 'Ada', bio: 'First programmer' },
    freshness: { updatedAt: now().toISOString(), updatedBy: 'agent' },
  })
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-form-action-'))
}
