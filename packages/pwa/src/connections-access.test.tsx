// @vitest-environment jsdom
import { ServiceConnectionsSnapshotSchema } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpaceWithSurfaces } from './api.ts'
import { ConnectionsPage } from './connections-page.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const at = '2026-10-05T12:00:00.000Z'
const revision = 'caa9d5f2-7407-4fc5-9199-fe671951e80c'
const workGrant = 'bfa4aa8f-7845-48ab-8b7a-afd7e8b41613'
const healthGrant = '7c68b686-3925-4542-a30f-2e6b9df39675'
const spaces = [
  fromPartial<SpaceWithSurfaces>({ id: 'spc-work', name: 'Work' }),
  fromPartial<SpaceWithSurfaces>({ id: 'spc-health', name: 'Health' }),
  fromPartial<SpaceWithSurfaces>({ id: 'spc-home', name: 'Home' }),
]
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function setup() {
  let failDisable = false
  let snapshot = ServiceConnectionsSnapshotSchema.parse({
    attempts: [],
    connections: [
      {
        id: 'github-work',
        service: 'github',
        mechanism: 'github-mcp-stdio',
        account: 'example',
        state: 'ready',
        scopes: ['GitHub Contents: read'],
        executionHost: 'Gateway',
        authorizationRevision: revision,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'gmail-personal',
        service: 'gmail',
        mechanism: 'gmail-oauth',
        account: 'person@example.com',
        state: 'needs_reconnect',
        scopes: ['gmail.readonly'],
        executionHost: 'Gateway',
        authorizationRevision: revision,
        createdAt: at,
        updatedAt: at,
      },
    ],
    grants: [
      {
        id: workGrant,
        spaceId: 'spc-work',
        connectionId: 'github-work',
        authorizationRevision: revision,
        actions: ['list_repositories', 'read_files'],
        repositoryScope: { mode: 'authorized' },
        enabled: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: healthGrant,
        spaceId: 'spc-health',
        connectionId: 'github-work',
        authorizationRevision: revision,
        actions: ['list_issues'],
        repository: { owner: 'example', name: 'health' },
        enabled: true,
        createdAt: at,
        updatedAt: at,
      },
      {
        id: 'f6d04acb-3f5a-4558-9bc3-64c97820e0ca',
        spaceId: 'spc-work',
        connectionId: 'gmail-personal',
        authorizationRevision: revision,
        actions: ['search_mailbox'],
        enabled: true,
        createdAt: at,
        updatedAt: at,
      },
    ],
  })
  const mutations: string[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const path = String(url)
    if (init?.method === 'POST') {
      mutations.push(path)
      if (failDisable) return response({ error: 'Could not disable access. Try again.' }, 503)
      snapshot = {
        ...snapshot,
        grants: snapshot.grants.map((grant) =>
          path === `/api/service-connections/grants/${grant.id}/disable`
            ? { ...grant, enabled: false }
            : grant,
        ),
      }
    }
    if (path.startsWith('/api/service-connections')) return response(snapshot)
    return response({ connections: [] })
  })
  return { mutations, failDisable: (value: boolean) => (failDisable = value) }
}

function view(section = 'access', items = spaces) {
  return (
    <MemoryRouter initialEntries={[`/app/connections?section=${section}`]}>
      <ConnectionsPage spaces={items} />
    </MemoryRouter>
  )
}

it('groups permissions by Space and distinguishes usable access from accounts needing review', async () => {
  setup()
  render(view())
  const work = await screen.findByRole('region', { name: /^Work/ })
  expect(within(work).getByText('List repositories, Read directories and text files')).toBeDefined()
  expect(within(work).getByText('All authorized repositories')).toBeDefined()
  expect(within(work).getByText('Needs review')).toBeDefined()
  expect(screen.getByRole('button', { name: /Work.*1 enabled/ })).toBeDefined()
  expect(within(work).queryByText('example/health')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /^Health/ }))
  const health = screen.getByRole('region', { name: /^Health/ })
  expect(within(health).getByText('example/health')).toBeDefined()
  expect(within(health).getByText('Read open issues')).toBeDefined()
  expect(within(health).queryByText('person@example.com')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: /^Home/ }))
  expect(
    within(screen.getByRole('region', { name: /^Home/ })).getByRole('link', {
      name: 'Manage accounts',
    }),
  ).toBeDefined()
})

it('recovers from a failed disable and updates only that Space, including after reload', async () => {
  const fixture = setup()
  fixture.failDisable(true)
  const first = render(view())
  const work = await screen.findByRole('region', { name: /^Work/ })
  const github = within(work).getByRole('listitem', { name: 'GitHub · example' })
  fireEvent.click(within(github).getByRole('button', { name: 'Disable access' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Could not disable access')
  expect(within(github).getByText('Enabled')).toBeDefined()
  fixture.failDisable(false)
  fireEvent.click(within(github).getByRole('button', { name: 'Disable access' }))
  await within(github).findByText('Disabled')
  expect(fixture.mutations).toEqual(
    Array(2).fill(`/api/service-connections/grants/${workGrant}/disable`),
  )
  first.unmount()
  render(view())
  const restored = await screen.findByRole('region', { name: /^Work/ })
  expect(within(restored).getByText('Disabled')).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /^Health/ }))
  expect(within(screen.getByRole('region', { name: /^Health/ })).getByText('Enabled')).toBeDefined()
})

it('does not announce empty access while loading or after a load failure, and offers retry', async () => {
  let ready = false
  vi.stubGlobal('fetch', async () =>
    ready
      ? response({ attempts: [], connections: [], grants: [] })
      : response({ error: 'Connection unavailable' }, 503),
  )
  render(view())
  expect(screen.getByRole('status').textContent).toContain('Loading Space access')
  expect(screen.queryByText('No service access')).toBeNull()
  await screen.findByRole('alert')
  expect(screen.queryByRole('button', { name: /^Work/ })).toBeNull()
  ready = true
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /^Work/ })).toBeDefined())
})

it('offers a way back to Home when no Spaces exist', async () => {
  setup()
  render(view('access', []))
  await screen.findByText('No Spaces yet')
  expect(screen.getByRole('link', { name: 'Go to Home' }).getAttribute('href')).toBe('/')
})

it('opens the existing account setup with the extension service selected', async () => {
  setup()
  render(view('extensions'))
  fireEvent.click(screen.getByRole('link', { name: 'Connect GitHub' }))
  const dialog = await screen.findByRole('dialog', { name: 'Add account' })
  expect(within(dialog).getByRole('combobox', { name: 'Service' })).toHaveProperty(
    'value',
    'github',
  )
  expect(within(dialog).getByText(/fine-grained GitHub token/)).toBeDefined()
})
