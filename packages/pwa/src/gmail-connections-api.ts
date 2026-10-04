import {
  BeginGmailAuthorizationResponseSchema,
  GmailConnectionsSnapshotSchema,
  type CreateGmailConnectionRequest,
  type ConfigureGmailOAuthClientRequest,
  type GmailConnectionsSnapshot,
} from '@veduta/protocol'
import { deleteJson, getJson, patchJson, postJson } from './api-http.ts'

const base = '/api/gmail-connections'
const itemPath = (id: string) => `${base}/${encodeURIComponent(id)}`

export async function fetchGmailConnections(token?: string): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(await getJson(base, token))
}

export async function configureGmailOAuthClient(
  input: ConfigureGmailOAuthClientRequest,
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(await postJson(`${base}/oauth-client`, input, token))
}

export async function createGmailConnection(
  input: CreateGmailConnectionRequest,
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(await postJson(base, input, token))
}

export async function renameGmailConnection(
  id: string,
  name: string,
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(await patchJson(itemPath(id), { name }, token))
}

export async function beginGmailAuthorization(id: string, token?: string): Promise<string> {
  const response = BeginGmailAuthorizationResponseSchema.parse(
    await postJson(`${itemPath(id)}/authorize`, { redirectOrigin: window.location.origin }, token),
  )
  return response.authorizationUrl
}

export async function completeGmailAuthorization(
  id: string,
  code: string,
  state: string,
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(
    await postJson(`${itemPath(id)}/complete`, { code, state }, token),
  )
}

export async function failGmailAuthorization(
  id: string,
  state: string,
  reason: 'access_denied' | 'other',
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(
    await postJson(`${itemPath(id)}/fail`, { state, reason }, token),
  )
}

export async function verifyLegacyGmailConnection(
  id: string,
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(
    await postJson(`${itemPath(id)}/verify-legacy`, {}, token),
  )
}

export async function removeGmailConnection(
  id: string,
  token?: string,
): Promise<GmailConnectionsSnapshot> {
  return GmailConnectionsSnapshotSchema.parse(await deleteJson(itemPath(id), token))
}
