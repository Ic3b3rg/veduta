import {
  SpaceSettingsSchema,
  SpaceSettingsListSchema,
  type SpaceSettingsCommand,
  type ReflectionSettingsChangeSchema,
} from '@veduta/protocol'
import type { z } from 'zod'
import { getJson, postJson } from './api-http.ts'

const path = (spaceId: string) => `/api/settings/spaces/${encodeURIComponent(spaceId)}`
export async function fetchSpaceSettingsList(token?: string) {
  return SpaceSettingsListSchema.parse(await getJson('/api/settings/spaces', token))
}
export async function fetchSpaceSettings(spaceId: string, token?: string) {
  return SpaceSettingsSchema.parse(await getJson(path(spaceId), token))
}
export async function changeSpaceSettings(
  spaceId: string,
  command: SpaceSettingsCommand,
  token?: string,
) {
  return SpaceSettingsSchema.parse(await postJson(path(spaceId), command, token))
}
export async function changeReflectionSettings(
  change: z.infer<typeof ReflectionSettingsChangeSchema>,
  token?: string,
) {
  return SpaceSettingsListSchema.parse(await postJson('/api/settings/reflection', change, token))
}
