import {
  ServiceConnectionsSnapshotSchema,
  type ServiceConnectionsSnapshot,
  type CreateServiceConnectionAttemptRequest,
} from '@veduta/protocol'
import { deleteJson, getJson, postJson } from './api-http.ts'

const base = '/api/service-connections'
const attemptPath = (id: string) => `${base}/attempts/${encodeURIComponent(id)}`

export async function fetchServiceConnections(token?: string): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(await getJson(base, token))
}

export async function createServiceConnectionAttempt(
  input: CreateServiceConnectionAttemptRequest,
  token?: string,
): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(await postJson(`${base}/attempts`, input, token))
}

export async function authorizeGithubAttempt(
  id: string,
  githubToken: string,
  token?: string,
): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(
    await postJson(`${attemptPath(id)}/github/authorize`, { token: githubToken }, token),
  )
}

export async function authorizeGmailAttempt(
  id: string,
  input: {
    gmailConnectionId?: string
    name?: string
    clientId?: string
    clientSecret?: string
  },
  token?: string,
): Promise<{ snapshot: ServiceConnectionsSnapshot; authorizationUrl?: string }> {
  const response = (await postJson(
    `${attemptPath(id)}/gmail/authorize`,
    { redirectOrigin: window.location.origin, ...input },
    token,
  )) as { snapshot: unknown; authorizationUrl?: unknown }
  return {
    snapshot: ServiceConnectionsSnapshotSchema.parse(response.snapshot),
    ...(typeof response.authorizationUrl === 'string'
      ? { authorizationUrl: response.authorizationUrl }
      : {}),
  }
}

export async function completeServiceGmailCallback(
  input: { code?: string; state: string; error?: string },
  token?: string,
): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(
    await postJson(`${base}/gmail/callback`, input, token),
  )
}

export async function confirmSpaceCapabilityGrant(
  id: string,
  account: string,
  scopes: string[],
  token?: string,
  spaceIds?: string[],
): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(
    await postJson(
      `${attemptPath(id)}/grant`,
      { account, scopes, ...(spaceIds ? { spaceIds } : {}) },
      token,
    ),
  )
}

export async function serviceConnectionAction(
  path: string,
  token?: string,
): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(await postJson(`${base}/${path}`, {}, token))
}

export async function removeServiceConnection(
  id: string,
  token?: string,
): Promise<ServiceConnectionsSnapshot> {
  return ServiceConnectionsSnapshotSchema.parse(
    await deleteJson(`${base}/${encodeURIComponent(id)}`, token),
  )
}
