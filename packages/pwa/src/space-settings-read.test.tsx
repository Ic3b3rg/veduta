// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import { SpaceSettingsSchema } from '@veduta/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import * as api from './api.ts'
import { ConnectionsSpaces } from './connections-spaces.tsx'
import { createPwaLiveStateRuntime } from './pwa-live-state-runtime.ts'
import { PwaRuntimeContext } from './use-live-state.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const space = { id: 'spc-health', slug: 'health', name: 'Health', archived: false }
function settings(tree: unknown) {
  return {
    space,
    instructions: 'Canonical instructions',
    facts: [],
    automations: [],
    surfaces: [
      {
        id: 'srf-reflection',
        spaceId: space.id,
        title: 'Reflection',
        management: 'reflection',
        tree,
        state: { detail: 'Known report content' },
        freshness: { updatedAt: '2026-10-10T10:00:00.000Z', updatedBy: 'job' },
      },
    ],
  }
}

it('keeps Settings usable and renders an unknown management Atom visibly through the read API', async () => {
  const payload = settings({
    id: 'future',
    type: 'FutureReport',
    props: { version: 2 },
    children: [{ id: 'known', type: 'Text', binding: 'detail' }],
  })
  expect(SpaceSettingsSchema.safeParse(payload).success).toBe(false)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url === '/api/settings/spaces'
              ? {
                  spaces: [space],
                  reflection: {
                    enabled: true,
                    time: '03:00',
                    timezone: 'UTC',
                    revision: 'reflection-1',
                  },
                }
              : payload,
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ),
  )
  const runtime = createPwaLiveStateRuntime({
    storage: fromPartial<Storage>({ getItem: () => null, setItem: () => {}, removeItem: () => {} }),
    api: {
      ...api,
      fetchAuthStatus: async () => ({
        mode: 'dev',
        bootstrapRequired: false,
        passkeyRegistered: false,
      }),
      fetchSpaces: async () => ({ spaces: [], surfaceCursor: 0 }),
      connectGateway: () => fromPartial<api.GatewayConnection>({ close: () => {} }),
    },
  })
  await runtime.start()
  try {
    render(
      <PwaRuntimeContext.Provider value={runtime}>
        <ConnectionsSpaces section="automations" initialSpaceId={space.id} />
      </PwaRuntimeContext.Provider>,
    )
    fireEvent.click(await screen.findByText('Last Nightly Reflection report'))
    expect((await screen.findByTestId('unknown-atom')).textContent).toContain(
      'unsupported Atom: FutureReport',
    )
    expect(screen.getByText('Known report content')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Nightly Reflection' })).toBeDefined()
  } finally {
    runtime.stop()
  }
})

it('still rejects invalid known Atom contracts in a Settings read', async () => {
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        JSON.stringify(
          settings({ id: 'bad', type: 'Title', props: { value: 'Undeclared field' } }),
        ),
        { status: 200 },
      ),
  )
  await expect(api.fetchSpaceSettings(space.id)).rejects.toThrow()
})
