import { Button } from '@veduta/catalog/ui/button'
import type { AuthDevice, AuthDevices, PairingCode } from '@veduta/protocol'
import { QRCodeSVG } from 'qrcode.react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createDeviceLink, fetchDevices, revokeDevice } from './devices-api.ts'
import { ConnectionsSection } from './connections-section.tsx'

export function ConnectionsDevices({ token }: { token?: string | undefined }) {
  if (!token)
    return (
      <ConnectionsSection title="Devices" description="Manage access to this Veduta installation.">
        <p>Device linking is available when Veduta requires passkey sign-in.</p>
      </ConnectionsSection>
    )
  return <DeviceAccess key={token} token={token} />
}

function DeviceAccess({ token }: { token: string }) {
  const [view, setView] = useState<{
    inventory: AuthDevices | null
    pairing: PairingCode | null
    pairingDeviceIds: string[]
    notice: string | null
  }>({ inventory: null, pairing: null, pairingDeviceIds: [], notice: null })
  const { inventory, pairing, notice } = view
  const readVersion = useRef(0)
  const mutating = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (mutating.current) return
    const version = ++readVersion.current
    try {
      const next = await fetchDevices(token)
      if (version !== readVersion.current) return
      setView((current) => {
        const linked =
          current.pairing !== null &&
          next.devices.some((device) => !current.pairingDeviceIds.includes(device.id))
        return {
          ...current,
          inventory: next,
          pairing: linked ? null : current.pairing,
          notice: linked
            ? 'A new device is linked. You can use Veduta on both devices.'
            : current.notice,
        }
      })
      setError(null)
      return next
    } catch (error) {
      if (version !== readVersion.current) return
      setError(error instanceof Error ? error.message : 'Could not load devices. Please retry.')
      return undefined
    }
  }, [token])

  useEffect(() => {
    const onFocus = () => void refresh()
    const initialRefresh = setTimeout(onFocus, 0)
    window.addEventListener('focus', onFocus)
    return () => {
      clearTimeout(initialRefresh)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => void refresh(), 3000)
    return () => clearInterval(timer)
  }, [pairing, refresh])

  const link = async () => {
    setBusy(true)
    setError(null)
    mutating.current = true
    readVersion.current++
    try {
      const inventory = await fetchDevices(token)
      const pairing = await createDeviceLink(token)
      setView({
        inventory,
        pairing,
        pairingDeviceIds: inventory.devices.map((device) => device.id),
        notice: null,
      })
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not create a device link.')
    } finally {
      mutating.current = false
      setBusy(false)
    }
  }

  const revoke = async (device: AuthDevice) => {
    setBusy(true)
    setError(null)
    mutating.current = true
    readVersion.current++
    try {
      await revokeDevice(token, device.id)
      setConfirmId(null)
      setView((current) => ({ ...current, notice: `Access revoked for ${device.name}.` }))
      mutating.current = false
      await refresh()
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not revoke access. Please retry.')
    } finally {
      mutating.current = false
      setBusy(false)
    }
  }

  return (
    <ConnectionsSection
      title="Devices"
      description="Link a phone or computer with its own passkey. All devices share your Spaces."
      actions={
        <Button disabled={busy || pairing !== null} onClick={() => void link()}>
          Link a device
        </Button>
      }
    >
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {pairing && (
        <DevicePairing
          pairing={pairing}
          onExpired={() => setView((current) => ({ ...current, pairing: null }))}
        />
      )}
      <div className="devices-toolbar">
        <p>
          Each entry is a registered passkey. Revoking it signs out every browser using that
          passkey, including synced copies.
        </p>
        <Button variant="outline" disabled={busy} onClick={() => void refresh()}>
          Refresh devices
        </Button>
      </div>
      {!inventory && !error && <p role="status">Loading devices…</p>}
      <div className="connections-grid">
        {inventory?.devices.map((device) => (
          <section
            className="device-access-card"
            role="group"
            aria-label={device.name}
            key={device.id}
          >
            <h2>{device.name}</h2>
            <p>Linked {new Date(device.createdAt).toLocaleDateString()}</p>
            {device.lastSeenAt && <p>Last used {new Date(device.lastSeenAt).toLocaleString()}</p>}
            {device.id === inventory.currentDeviceId ? (
              <p>This access</p>
            ) : confirmId === device.id ? (
              <>
                <p>
                  Revoke access for {device.name}? Its passkey and active sessions will stop
                  working.
                </p>
                <div className="device-access-actions">
                  <Button variant="destructive" disabled={busy} onClick={() => void revoke(device)}>
                    Confirm revoke
                  </Button>
                  <Button variant="outline" disabled={busy} onClick={() => setConfirmId(null)}>
                    Cancel
                  </Button>
                </div>
              </>
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => setConfirmId(device.id)}>
                Revoke access
              </Button>
            )}
          </section>
        ))}
      </div>
    </ConnectionsSection>
  )
}

function DevicePairing({ pairing, onExpired }: { pairing: PairingCode; onExpired: () => void }) {
  const [now, setNow] = useState(Date.now)
  const [copyState, setCopyState] = useState('Copy link')
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const expired = now >= Date.parse(pairing.expiresAt)
  return (
    <section className="device-pairing" aria-label="Link a device">
      {expired ? (
        <>
          <p role="status">This device link has expired. Generate a new one to continue.</p>
          <Button onClick={onExpired}>Dismiss expired link</Button>
        </>
      ) : (
        <>
          <div className="device-pairing-qr">
            <QRCodeSVG
              value={pairing.pairingUri}
              size={224}
              marginSize={4}
              role="img"
              aria-label="Scan to link a device"
            />
          </div>
          <div className="device-pairing-instructions">
            <h2>Open on your new device</h2>
            <p>
              Scan this QR code with your phone camera, or open the link on the other computer. If
              you use Tailscale, connect it there first.
            </p>
            <p>
              Choose Register passkey on that device. This one-time link expires at{' '}
              {new Date(pairing.expiresAt).toLocaleTimeString()}.
            </p>
            <p>Only share this link with a device you want to give access to your Veduta.</p>
            <label htmlFor="device-link">Device linking link</label>
            <input
              id="device-link"
              value={pairing.pairingUri}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <Button
              variant="outline"
              onClick={() => {
                void (
                  navigator.clipboard?.writeText(pairing.pairingUri) ??
                  Promise.reject(new Error('Clipboard unavailable'))
                ).then(
                  () => setCopyState('Link copied'),
                  () => setCopyState('Select the link above to copy it'),
                )
              }}
            >
              {copyState}
            </Button>
            <p>
              Or enter code <strong>{pairing.code}</strong> in the sign-in screen on the new device.
            </p>
          </div>
        </>
      )}
    </section>
  )
}
