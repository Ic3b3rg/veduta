import {
  AuthorizeModelConnectionResponseSchema,
  ModelConnectionCatalogResponseSchema,
  ModelConnectionSchema,
  ModelConnectionsSnapshotSchema,
  VerifyModelConnectionResponseSchema,
  type ApplyModelSelectionRequest,
  type AuthorizeModelConnectionRequest,
  type AuthorizeModelConnectionResponse,
  type CreateModelConnectionRequest,
  type ModelConnection,
  type ModelConnectionCatalogResponse,
  type ModelConnectionsSnapshot,
  type UpdateModelConnectionRequest,
  type VerifyModelConnectionResponse,
} from '@veduta/protocol'
import { deleteJson, getJson, patchJson, postJson } from './api-http.ts'

export async function fetchModelConnections(token?: string): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(await getJson('/api/model-connections', token))
}

export async function createModelConnection(
  request: CreateModelConnectionRequest,
  token?: string,
): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(
    await postJson('/api/model-connections', request, token),
  )
}

export async function authorizeModelConnection(
  id: string,
  request: AuthorizeModelConnectionRequest,
  token?: string,
): Promise<AuthorizeModelConnectionResponse> {
  return AuthorizeModelConnectionResponseSchema.parse(
    await postJson(`/api/model-connections/${encodeURIComponent(id)}/authorize`, request, token),
  )
}

export async function fetchModelConnection(id: string, token?: string): Promise<ModelConnection> {
  return ModelConnectionSchema.parse(
    await getJson(`/api/model-connections/${encodeURIComponent(id)}`, token),
  )
}

export async function refreshModelConnectionCatalog(
  id: string,
  token?: string,
): Promise<ModelConnectionCatalogResponse> {
  return ModelConnectionCatalogResponseSchema.parse(
    await postJson(`/api/model-connections/${encodeURIComponent(id)}/catalog`, {}, token),
  )
}

export async function verifyModelConnection(
  id: string,
  modelId: string,
  token?: string,
): Promise<VerifyModelConnectionResponse> {
  return VerifyModelConnectionResponseSchema.parse(
    await postJson(`/api/model-connections/${encodeURIComponent(id)}/verify`, { modelId }, token),
  )
}

export async function updateModelConnection(
  id: string,
  patch: UpdateModelConnectionRequest,
  token?: string,
): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(
    await patchJson(`/api/model-connections/${encodeURIComponent(id)}`, patch, token),
  )
}

export async function deleteModelConnection(
  id: string,
  token?: string,
): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(
    await deleteJson(`/api/model-connections/${encodeURIComponent(id)}`, token),
  )
}

export async function applyModelSelection(
  request: ApplyModelSelectionRequest,
  token?: string,
): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(
    await postJson('/api/model-connections/selection', request, token),
  )
}

export async function setMockProvider(
  enabled: boolean,
  token?: string,
): Promise<ModelConnectionsSnapshot> {
  return ModelConnectionsSnapshotSchema.parse(
    await postJson('/api/model-connections/mock', { enabled }, token),
  )
}
