import { AuthDevicesSchema, PairingCodeSchema } from '@veduta/protocol'
import {
  authHeaders,
  getJson,
  postJson,
  ApiResponseError,
  errorMessageFromBody,
} from './api-http.ts'

export async function fetchDevices(token: string) {
  return AuthDevicesSchema.parse(await getJson('/api/auth/devices', token))
}

export async function createDeviceLink(token: string) {
  return PairingCodeSchema.parse(await postJson('/api/auth/pairing-codes', {}, token))
}

export async function revokeDevice(token: string, deviceId: string): Promise<void> {
  const path = `/api/auth/devices/${encodeURIComponent(deviceId)}/revoke`
  const response = await fetch(path, { method: 'POST', headers: authHeaders(token) })
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined)
    throw new ApiResponseError(errorMessageFromBody(response.status, path, body), response.status)
  }
}
