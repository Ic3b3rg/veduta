// @vitest-environment jsdom
import { ConnectionAttemptSchema, ServiceConnectionsSnapshotSchema } from '@veduta/protocol'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { fromPartial } from '@total-typescript/shoehorn'
import type { SpaceWithSurfaces } from './api.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsPage } from './connections-page.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const at = '2026-10-04T12:00:00.000Z'
const attemptId = 'aa6849aa-d68e-46bb-89d7-d935d55c82ef'
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(mobile = false, googleConfigured = false, githubAuthorized = false) {
  let configured = googleConfigured
  let snapshot = ServiceConnectionsSnapshotSchema.parse({
    attempts: [],
    connections: [],
    grants: [],
  })
  const requests: { path: string; body: unknown }[] = []
  vi.stubGlobal('matchMedia', () => ({
    matches: mobile,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url)
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        requests.push({ path, body })
        if (path.endsWith('/cancel')) {
          snapshot = {
            ...snapshot,
            attempts: snapshot.attempts.map((attempt) => ({ ...attempt, state: 'cancelled' })),
          }
          return response(snapshot)
        }
        if (path === '/api/service-connections/attempts') {
          snapshot = ServiceConnectionsSnapshotSchema.parse({
            ...snapshot,
            attempts: [
              ConnectionAttemptSchema.parse({
                id: attemptId,
                submissionId: body['submissionId'],
                origin: 'management',
                requestSummary: body['service'] === 'gmail' ? 'Connect Gmail' : 'Connect GitHub',
                review:
                  body['service'] === 'gmail'
                    ? {
                        service: 'gmail',
                        scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
                        actions: ['search_mailbox'],
                        executionHost: 'Gateway native HTTPS',
                      }
                    : {
                        service: 'github',
                        scopes: body['repository']
                          ? ['GitHub Issues: read in example/disposable']
                          : [
                              'GitHub Metadata: read',
                              'GitHub Contents: read',
                              'GitHub Issues: read',
                            ],
                        actions: body['repository']
                          ? ['list_issues']
                          : ['list_repositories', 'list_issues', 'read_files'],
                        ...(body['repository']
                          ? { repository: body['repository'] }
                          : { repositoryScope: { mode: 'authorized' } }),
                        executionHost: 'Gateway local stdio',
                        serverVersion: 'v1.12.2',
                      },
                state: 'reviewing',
                createdAt: at,
                updatedAt: at,
              }),
            ],
          })
          return response(snapshot)
        }
        if (path.endsWith('/github/authorize')) {
          if (!githubAuthorized) return response({ error: 'GitHub verification failed' }, 502)
          const attempt = snapshot.attempts[0]!
          snapshot = ServiceConnectionsSnapshotSchema.parse({
            ...snapshot,
            attempts: [
              {
                ...attempt,
                state: 'ready',
                connectionId: 'fixture-github',
                verifiedAccount: 'fixture',
                verifiedScopes: attempt.review.scopes,
              },
            ],
            connections: [
              {
                id: 'fixture-github',
                service: 'github',
                mechanism: 'github-mcp-stdio',
                account: 'fixture',
                state: 'ready',
                scopes: attempt.review.scopes,
                executionHost: attempt.review.executionHost,
                authorizationRevision: '1797c6b2-d096-499b-8b55-1aa5e0fa2527',
                createdAt: at,
                updatedAt: at,
              },
            ],
          })
          return response(snapshot)
        }
        if (path.endsWith('/grant')) return response(snapshot)
        if (path === '/api/gmail-connections/oauth-client') {
          configured = true
          return response({ connections: [], oauthClient: { configured } })
        }
        if (path.endsWith('/gmail/authorize'))
          return response({ error: 'Google authorization could not start' }, 502)
      }
      if (path === '/api/service-connections') return response(snapshot)
      if (path === '/api/gmail-connections')
        return response({ connections: [], oauthClient: { configured } })
      if (path === '/api/himalaya-connections') return response({ connections: [] })
      throw new Error(`Unexpected request: ${path}`)
    }),
  )
  return requests
}

describe('ConnectionsPage', () => {
  it.each(['failed', 'ready'] as const)(
    'renews a saved %s Gmail account through the shared authorization review',
    async (state) => {
      setup()
      const connectionId = 'svc-gmail-saved-proof'
      const requests: { path: string; body: unknown }[] = []
      let snapshot = ServiceConnectionsSnapshotSchema.parse({
        attempts: [],
        connections: [],
        grants: [],
      })
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const path = String(url)
        if (init?.method === 'POST') {
          const body = JSON.parse(String(init.body)) as Record<string, unknown>
          requests.push({ path, body })
          if (path === '/api/service-connections/attempts') {
            snapshot = ServiceConnectionsSnapshotSchema.parse({
              ...snapshot,
              attempts: [
                {
                  id: attemptId,
                  submissionId: body['submissionId'],
                  origin: 'management',
                  requestSummary: 'Connect Gmail',
                  connectionId,
                  renewAuthorization: body['renewAuthorization'],
                  review: {
                    service: 'gmail',
                    scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
                    actions: ['search_mailbox'],
                    executionHost: 'Gateway native HTTPS',
                  },
                  state: 'reviewing',
                  createdAt: at,
                  updatedAt: at,
                },
              ],
            })
            return response(snapshot)
          }
          return response({ error: 'Google authorization could not start' }, 502)
        }
        if (path === '/api/service-connections') return response(snapshot)
        if (path === '/api/gmail-connections')
          return response({
            oauthClient: { configured: true },
            connections: [
              {
                id: connectionId,
                name: 'Saved Gmail',
                state,
                accountEmail: 'saved@gmail.test',
                scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
                createdAt: at,
                updatedAt: at,
              },
            ],
          })
        return response({ connections: [] })
      })
      render(
        <MemoryRouter initialEntries={['/app/connections']}>
          <ConnectionsPage spaces={[]} />
        </MemoryRouter>,
      )
      fireEvent.click(
        await screen.findByRole('button', { name: new RegExp(`Saved Gmail.*${state}`) }),
      )
      fireEvent.click(
        screen.getByRole('button', {
          name: state === 'ready' ? 'Reconnect' : 'Authorize with Google',
        }),
      )
      const detail = await screen.findByRole('dialog', { name: 'Gmail setup' })
      expect(within(detail).getByRole('status').textContent).toContain('State: reviewing')
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        path: '/api/service-connections/attempts',
        body: { service: 'gmail', connectionId, renewAuthorization: true },
      })
      await waitFor(() =>
        expect(within(detail).getByRole('button', { name: 'Continue to Google' })).toHaveProperty(
          'disabled',
          false,
        ),
      )
      fireEvent.click(within(detail).getByRole('button', { name: 'Continue to Google' }))
      await within(detail).findByRole('alert')
      expect(requests[1]).toMatchObject({
        path: `/api/service-connections/attempts/${attemptId}/gmail/authorize`,
        body: { gmailConnectionId: connectionId, redirectOrigin: window.location.origin },
      })
      expect(
        requests.some(
          (request) => request.path === `/api/gmail-connections/${connectionId}/authorize`,
        ),
      ).toBe(false)
    },
  )

  it('uses a compact dedicated layout and reviews an account before authorization, with honest errors', async () => {
    const requests = setup()
    render(
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    await screen.findByText('No accounts connected yet.')
    expect(screen.queryByText('Overview')).toBeNull()
    expect(screen.queryByText('Connections & integrations')).toBeNull()
    expect(screen.getByRole('link', { name: 'Back to Veduta' }).getAttribute('href')).toBe('/')
    expect(screen.queryByText('GitHub')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'github' } })
    expect(screen.queryByText('Another email provider?')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect IMAP and SMTP' })).toBeNull()
    expect(screen.queryByLabelText('Repository owner')).toBeNull()
    fireEvent.submit(document.getElementById('create-service')!)
    const detail = await screen.findByRole('dialog', { name: 'GitHub setup' })
    expect(requests[0]?.body).toMatchObject({
      service: 'github',
    })
    expect(
      (within(detail).getByRole('button', { name: 'Verify GitHub' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.submit(document.getElementById(`authorize-${attemptId}`)!)
    expect(requests).toHaveLength(1)
    expect(within(detail).queryByRole('checkbox')).toBeNull()
    const creationUrl = new URL(
      within(detail).getByRole('link', { name: 'Create a token for Veduta' }).getAttribute('href')!,
    )
    expect(creationUrl.searchParams.get('contents')).toBe('read')
    expect(creationUrl.searchParams.get('issues')).toBe('read')
    fireEvent.change(within(detail).getByLabelText('Fine-grained GitHub token'), {
      target: { value: 'github_pat_' + 'x'.repeat(30) },
    })
    fireEvent.submit(document.getElementById(`authorize-${attemptId}`)!)
    await waitFor(() =>
      expect(within(detail).getByRole('alert').textContent).toBe('GitHub verification failed'),
    )
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(
      (within(detail).getByLabelText('Fine-grained GitHub token') as HTMLInputElement).value,
    ).toBe('')
    expect(screen.queryByRole('button', { name: 'Save access' })).toBeNull()
  })

  it('guides Google setup once and sends credentials only to the protected configuration endpoint', async () => {
    const requests = setup()
    render(
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    await screen.findByText('No accounts connected yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    fireEvent.submit(document.getElementById('create-service')!)
    const detail = await screen.findByRole('dialog', { name: 'Gmail setup' })
    expect(within(detail).getByRole('link', { name: 'Enable Gmail API' })).toBeDefined()
    expect(within(detail).getByRole('button', { name: 'Copy redirect URI' })).toBeDefined()
    fireEvent.change(within(detail).getByLabelText('Google OAuth client ID'), {
      target: { value: 'guided-client' },
    })
    fireEvent.change(within(detail).getByLabelText('Google OAuth client secret'), {
      target: { value: 'guided-secret' },
    })
    fireEvent.submit(document.getElementById(`authorize-${attemptId}`)!)
    await waitFor(() =>
      expect(within(detail).getByRole('alert').textContent).toBe(
        'Google authorization could not start',
      ),
    )
    expect(requests.slice(1)).toEqual([
      {
        path: '/api/gmail-connections/oauth-client',
        body: { clientId: 'guided-client', clientSecret: 'guided-secret' },
      },
      {
        path: `/api/service-connections/attempts/${attemptId}/gmail/authorize`,
        body: { redirectOrigin: window.location.origin, name: 'Gmail' },
      },
    ])
    expect(within(detail).queryByLabelText('Google OAuth client secret')).toBeNull()
    expect(
      within(detail).getByText('Google OAuth is configured for this installation.'),
    ).toBeDefined()
    expect(within(detail).queryByRole('button', { name: 'Save access' })).toBeNull()
  })

  it('connects a subsequent Gmail account without collecting Google client credentials again', async () => {
    const requests = setup(false, true)
    render(
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    await screen.findByText('No accounts connected yet.')
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }))
    fireEvent.submit(document.getElementById('create-service')!)
    const detail = await screen.findByRole('dialog', { name: 'Gmail setup' })
    expect(within(detail).queryByLabelText('Google OAuth client ID')).toBeNull()
    fireEvent.submit(document.getElementById(`authorize-${attemptId}`)!)
    await waitFor(() =>
      expect(within(detail).getByRole('alert').textContent).toBe(
        'Google authorization could not start',
      ),
    )
    expect(requests.slice(1)).toEqual([
      {
        path: `/api/service-connections/attempts/${attemptId}/gmail/authorize`,
        body: { redirectOrigin: window.location.origin, name: 'Gmail' },
      },
    ])
  })

  it('opens a modal Sheet on mobile and restores focus after Escape', async () => {
    setup(true)
    render(
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    await screen.findByText('No accounts connected yet.')
    const add = screen.getByRole('button', { name: 'Add account' })
    add.focus()
    fireEvent.click(add)
    const dialog = await screen.findByRole('dialog', { name: 'Add account' })
    expect(dialog.getAttribute('data-slot')).toBe('sheet-content')
    expect(within(dialog).getByRole('button', { name: 'Review access' })).toBeDefined()
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(add))
  })

  it('keeps a rejected creation inside the modal and clears it when starting a fresh account', async () => {
    setup()
    const fetch = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      init?.method === 'POST' && String(url) === '/api/service-connections/attempts'
        ? response({ error: 'Invalid connection setup request' }, 400)
        : fetch(url, init),
    )
    render(
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    await screen.findByText('No accounts connected yet.')
    const add = screen.getByRole('button', { name: 'Add account' })
    add.focus()
    fireEvent.click(add)
    const modal = await screen.findByRole('dialog', { name: 'Add account' })
    fireEvent.change(within(modal).getByLabelText('Service'), { target: { value: 'github' } })
    fireEvent.submit(document.getElementById('create-service')!)
    expect((await within(modal).findByRole('alert')).textContent).toBe(
      'Invalid connection setup request',
    )
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)
    fireEvent.keyDown(modal, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(add))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(add)
    const fresh = await screen.findByRole('dialog', { name: 'Add account' })
    expect(within(fresh).queryByRole('alert')).toBeNull()
    fireEvent.change(within(fresh).getByLabelText('Service'), { target: { value: 'mailbox' } })
    fireEvent.click(within(fresh).getByRole('button', { name: 'Continue' }))
    const mailbox = await screen.findByRole('dialog', { name: 'Connect a mailbox' })
    expect(within(mailbox).getByLabelText('IMAP server URL')).toBeDefined()
    expect(within(mailbox).queryByLabelText('Fine-grained GitHub token')).toBeNull()
  })

  it('does not turn historical attempts or a removed account back into visible setup requests after reload', async () => {
    setup()
    const review = {
      service: 'github',
      scopes: ['GitHub Metadata: read'],
      actions: ['list_repositories'],
      executionHost: 'Gateway local stdio',
    }
    const snapshot = ServiceConnectionsSnapshotSchema.parse({
      attempts: [
        {
          id: attemptId,
          submissionId: '0bf2b3fb-6d13-4e2c-b602-199c653cd324',
          origin: 'management',
          requestSummary: 'Connect GitHub',
          review,
          state: 'ready',
          connectionId: 'removed-account',
          createdAt: at,
          updatedAt: at,
        },
        {
          id: 'a168cb72-6739-4c3d-8f92-a137d8cf1693',
          submissionId: 'a5e242ae-ea9a-4ca7-9676-d0330f30bf99',
          origin: 'management',
          requestSummary: 'Connect GitHub',
          review,
          state: 'failed',
          reason: 'Verification failed',
          createdAt: at,
          updatedAt: at,
        },
      ],
      connections: [
        {
          id: 'removed-account',
          service: 'github',
          mechanism: 'github-mcp-stdio',
          account: 'old-account',
          scopes: review.scopes,
          executionHost: review.executionHost,
          authorizationRevision: 'caa9d5f2-7407-4fc5-9199-fe671951e80c',
          state: 'removed',
          createdAt: at,
          updatedAt: at,
        },
      ],
      grants: [],
    })
    const fetch = globalThis.fetch
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      String(url) === '/api/service-connections'
        ? Promise.resolve(response(snapshot))
        : fetch(url, init),
    )
    const view = () => (
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>
    )
    const first = render(view())
    await screen.findByText('No accounts connected yet.')
    expect(screen.queryByText('Setup requests')).toBeNull()
    expect(screen.queryByRole('button', { name: /GitHub setup/ })).toBeNull()
    first.unmount()
    render(view())
    await screen.findByText('No accounts connected yet.')
    expect(screen.queryByText('Setup requests')).toBeNull()
    expect(screen.queryByText('old-account')).toBeNull()
  })

  it.each([false, true])(
    'dismisses a failed authorization without a setup card (cleanup needs retry: %s)',
    async (retryCleanup) => {
      setup(true)
      let attempt = ConnectionAttemptSchema.parse({
        id: attemptId,
        submissionId: '69ed1cf2-e1fd-4b58-b2aa-999c304beb55',
        origin: 'management',
        requestSummary: 'Connect Gmail',
        review: {
          service: 'gmail',
          scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
          actions: ['search_mailbox'],
          executionHost: 'Gateway native HTTPS',
        },
        state: 'failed',
        reason: 'Gmail authorization was declined.',
        createdAt: at,
        updatedAt: at,
      })
      const actions: string[] = []
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        const path = String(url)
        if (init?.method === 'POST') {
          actions.push(path)
          if (path.endsWith('/retry')) attempt = { ...attempt, state: 'reviewing' }
          else if (path.endsWith('/cancel')) {
            attempt = { ...attempt, state: 'cancelled' }
            if (retryCleanup && actions.length === 1)
              return response({ error: 'Could not finish account cleanup' }, 500)
          } else throw new Error(`Unexpected mutation: ${path}`)
        }
        if (path.startsWith('/api/service-connections'))
          return response({ attempts: [attempt], connections: [], grants: [] })
        if (path === '/api/gmail-connections')
          return response({ connections: [], oauthClient: { configured: true } })
        return response({ connections: [] })
      })
      render(
        <MemoryRouter initialEntries={[`/app/connections?attempt=${attemptId}`]}>
          <ConnectionsPage spaces={[]} />
        </MemoryRouter>,
      )
      const dialog = await screen.findByRole('dialog', { name: 'Gmail setup' })
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel setup' }))
      if (retryCleanup) {
        expect((await within(dialog).findByRole('alert')).textContent).toBe(
          'Could not finish account cleanup',
        )
        expect(screen.getByRole('dialog')).toBe(dialog)
        fireEvent.click(within(dialog).getByRole('button', { name: 'Close details' }))
      }
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(actions).toEqual(
        Array.from(
          { length: retryCleanup ? 2 : 1 },
          () => `/api/service-connections/attempts/${attemptId}/cancel`,
        ),
      )
      expect(screen.queryByText('Setup requests')).toBeNull()
      expect(screen.getByText('No accounts connected yet.')).toBeDefined()
    },
  )

  it('saves the verified account and restores focus when the empty-state opener has disappeared', async () => {
    setup(false, false, true)
    render(
      <MemoryRouter initialEntries={['/app/connections']}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    const first = await screen.findByRole('button', { name: 'Connect your first account' })
    first.focus()
    fireEvent.click(first)
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'github' } })
    fireEvent.submit(document.getElementById('create-service')!)
    const modal = await screen.findByRole('dialog', { name: 'GitHub setup' })
    fireEvent.change(within(modal).getByLabelText('Fine-grained GitHub token'), {
      target: { value: 'github_pat_' + 'x'.repeat(30) },
    })
    fireEvent.submit(document.getElementById(`authorize-${attemptId}`)!)
    fireEvent.click(await within(modal).findByRole('button', { name: 'Save access' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(first.isConnected).toBe(false)
    expect(screen.getByRole('button', { name: /GitHub.*fixture/ })).toBeDefined()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add account' })),
    )
  })

  it('cancels an unfinished account addition on Escape and returns focus to Add account', async () => {
    const requests = setup(true)
    await fetch('/api/service-connections/attempts', {
      method: 'POST',
      body: JSON.stringify({
        submissionId: 'ec4b68eb-0966-47f2-a1bf-60034875b3ab',
        repository: { owner: 'example', name: 'disposable' },
      }),
    })
    render(
      <MemoryRouter initialEntries={[`/app/connections?attempt=${attemptId}`]}>
        <ConnectionsPage spaces={[]} />
      </MemoryRouter>,
    )
    const dialog = await screen.findByRole('dialog', { name: 'GitHub setup' })
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(requests.at(-1)?.path).toBe(`/api/service-connections/attempts/${attemptId}/cancel`)
    expect(screen.queryByText('Setup requests')).toBeNull()
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add account' })),
    )
  })

  it('returns a Gmail OAuth callback to the original Chat grant and keeps it discoverable', async () => {
    const connectionId = 'svc-gmail-callback-proof'
    const review = {
      service: 'gmail',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      actions: ['search_mailbox'],
      executionHost: 'Gateway native HTTPS',
    }
    let snapshot = ServiceConnectionsSnapshotSchema.parse({
      attempts: [
        {
          id: attemptId,
          submissionId: '8ad6d611-6ab5-4f79-98ca-c9d55eb0d016',
          turnId: 'cht-original',
          spaceId: 'spc-work',
          requestSummary: 'Find unread mail in Work',
          review,
          state: 'authorizing',
          connectionId,
          createdAt: at,
          updatedAt: at,
        },
      ],
      connections: [],
      grants: [],
    })
    const callback = vi.fn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url) === '/api/service-connections/gmail/callback') {
          callback()
          snapshot = ServiceConnectionsSnapshotSchema.parse({
            ...snapshot,
            attempts: snapshot.attempts.map((item) => ({
              ...item,
              state: 'ready',
              verifiedAccount: 'proof@example.com',
              verifiedScopes: review.scopes,
            })),
            connections: [
              {
                id: connectionId,
                service: 'gmail',
                mechanism: 'gmail-oauth',
                account: 'proof@example.com',
                scopes: review.scopes,
                executionHost: review.executionHost,
                authorizationRevision: '9660fcc8-72a8-4c18-85f7-7d0b223df1dc',
                state: 'ready',
                createdAt: at,
                updatedAt: at,
              },
            ],
          })
          return response(snapshot)
        }
        if (String(url) === '/api/service-connections') return response(snapshot)
        return response({ connections: [] })
      }),
    )
    window.history.replaceState(
      null,
      '',
      `/app/connections?code=one-use-test-code&state=${connectionId}.test-nonce`,
    )
    render(
      <MemoryRouter initialEntries={[window.location.pathname + window.location.search]}>
        <ConnectionsPage
          spaces={[fromPartial<SpaceWithSurfaces>({ id: 'spc-work', name: 'Work' })]}
        />
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: 'Grant to Work and resume' })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog', { name: 'Gmail setup' })).toBeDefined()
    expect(screen.queryByText('Setup requests')).toBeNull()
    expect(window.location.search).not.toContain('code=')
    expect(window.location.search).not.toContain('state=')
    window.history.replaceState(null, '', '/')
  })
})
