// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionsDevices } from './connections-devices.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setup() {
  let devices = [
    {
      id: 'desktop',
      name: 'Computer',
      credentialId: 'key-one',
      createdAt: '2026-10-08T00:00:00.000Z',
    },
    { id: 'phone', name: 'Phone', credentialId: 'key-two', createdAt: '2026-10-08T00:00:00.000Z' },
  ]
  const writes: string[] = []
  const fetch = vi.fn(async (input: string, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer vdt_owner_session')
    if (input === '/api/auth/devices') return Response.json({ devices, currentDeviceId: 'desktop' })
    writes.push(input)
    if (input === '/api/auth/pairing-codes')
      return Response.json({
        code: 'phone-link',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        pairingUri: 'https://veduta.example/setup?code=phone-link',
      })
    if (input === '/api/auth/devices/phone/revoke') {
      devices = devices.filter((device) => device.id !== 'phone')
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected request: ${input}`)
  })
  vi.stubGlobal('fetch', fetch)
  return { writes, fetch }
}

describe('device access management', () => {
  it('links a second device with an expiring QR and protects the current access', async () => {
    setup()
    render(<ConnectionsDevices token="vdt_owner_session" />)
    const computer = await screen.findByRole('group', { name: 'Computer' })
    expect(within(computer).getByText('This access')).toBeDefined()
    expect(within(computer).queryByRole('button', { name: /revoke/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Link a device' }))
    expect(await screen.findByRole('img', { name: 'Scan to link a device' })).toBeDefined()
    expect(screen.getByLabelText('Device linking link').getAttribute('value')).toBe(
      'https://veduta.example/setup?code=phone-link',
    )
    expect(screen.getByText(/expires at/i)).toBeDefined()
  })

  it('revokes only the selected device after confirmation and refreshes the list', async () => {
    const { writes } = setup()
    render(<ConnectionsDevices token="vdt_owner_session" />)
    const phone = await screen.findByRole('group', { name: 'Phone' })
    fireEvent.click(within(phone).getByRole('button', { name: 'Revoke access' }))
    expect(writes).toEqual([])
    fireEvent.click(within(phone).getByRole('button', { name: 'Confirm revoke' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Phone' })).toBeNull())
    expect(writes).toEqual(['/api/auth/devices/phone/revoke'])
    expect(screen.getByRole('group', { name: 'Computer' })).toBeDefined()
  })

  it('offers a retry when the device list cannot be loaded', async () => {
    const { fetch } = setup()
    fetch.mockRejectedValueOnce(new Error('Connection lost'))
    render(<ConnectionsDevices token="vdt_owner_session" />)
    expect((await screen.findByRole('alert')).textContent).toContain('Connection lost')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    expect(await screen.findByRole('group', { name: 'Computer' })).toBeDefined()
  })

  it('clears a used link when a focus refresh discovers the newly linked device', async () => {
    const { fetch } = setup()
    render(<ConnectionsDevices token="vdt_owner_session" />)
    await screen.findByRole('group', { name: 'Computer' })
    fireEvent.click(screen.getByRole('button', { name: 'Link a device' }))
    await screen.findByRole('img', { name: 'Scan to link a device' })
    fetch.mockResolvedValueOnce(
      Response.json({
        currentDeviceId: 'desktop',
        devices: [
          {
            id: 'tablet',
            name: 'Tablet',
            credentialId: 'key-three',
            createdAt: '2026-10-08T00:00:00.000Z',
          },
        ],
      }),
    )
    fireEvent(window, new Event('focus'))
    expect(
      await screen.findByText('A new device is linked. You can use Veduta on both devices.'),
    ).toBeDefined()
    expect(screen.queryByRole('img', { name: 'Scan to link a device' })).toBeNull()
  })

  it('does not restore a revoked device from an older in-flight refresh', async () => {
    const { fetch } = setup()
    render(<ConnectionsDevices token="vdt_owner_session" />)
    const phone = await screen.findByRole('group', { name: 'Phone' })
    let finishStaleRead: (value: Response) => void = () => {
      throw new Error('Read not started')
    }
    fetch.mockReturnValueOnce(
      new Promise((resolve) => {
        finishStaleRead = resolve
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh devices' }))
    fireEvent.click(within(phone).getByRole('button', { name: 'Revoke access' }))
    fireEvent.click(within(phone).getByRole('button', { name: 'Confirm revoke' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Phone' })).toBeNull())
    await act(async () =>
      finishStaleRead(
        Response.json({
          currentDeviceId: 'desktop',
          devices: [
            {
              id: 'phone',
              name: 'Phone',
              credentialId: 'key-two',
              createdAt: '2026-10-08T00:00:00.000Z',
            },
          ],
        }),
      ),
    )
    expect(screen.queryByRole('group', { name: 'Phone' })).toBeNull()
    expect(screen.getByRole('group', { name: 'Computer' })).toBeDefined()
  })
})
