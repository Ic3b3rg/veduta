import {
  HimalayaConnectionsSnapshotSchema,
  type CreateHimalayaConnectionRequest,
  type HimalayaConnectionsSnapshot,
} from '@veduta/protocol'
import { deleteJson, getJson, patchJson, postJson } from './api-http.ts'

const base = '/api/himalaya-connections'
const item = (id: string) => `${base}/${encodeURIComponent(id)}`

export async function fetchHimalayaConnections(
  token?: string,
): Promise<HimalayaConnectionsSnapshot> {
  return HimalayaConnectionsSnapshotSchema.parse(await getJson(base, token))
}

export async function createHimalayaConnection(
  input: CreateHimalayaConnectionRequest,
  token?: string,
): Promise<HimalayaConnectionsSnapshot> {
  return HimalayaConnectionsSnapshotSchema.parse(await postJson(base, input, token))
}

export async function completeLegacyHimalayaConnection(
  id: string,
  input: {
    name: string
    address: string
    smtpServer: string
    smtpUsername: string
    smtpPassword: string
  },
  token?: string,
): Promise<HimalayaConnectionsSnapshot> {
  return HimalayaConnectionsSnapshotSchema.parse(
    await postJson(`${item(id)}/complete-legacy`, input, token),
  )
}

export async function verifyHimalayaConnection(
  id: string,
  token?: string,
): Promise<HimalayaConnectionsSnapshot> {
  return HimalayaConnectionsSnapshotSchema.parse(await postJson(`${item(id)}/verify`, {}, token))
}

export async function installHimalaya(
  token?: string,
): Promise<{ state: 'ready' | 'failed'; reason?: string }> {
  return (await postJson(`${base}/install`, {}, token)) as {
    state: 'ready' | 'failed'
    reason?: string
  }
}

export async function renameHimalayaConnection(
  id: string,
  name: string,
  token?: string,
): Promise<HimalayaConnectionsSnapshot> {
  return HimalayaConnectionsSnapshotSchema.parse(await patchJson(item(id), { name }, token))
}

export async function removeHimalayaConnection(
  id: string,
  token?: string,
): Promise<HimalayaConnectionsSnapshot> {
  return HimalayaConnectionsSnapshotSchema.parse(await deleteJson(item(id), token))
}
