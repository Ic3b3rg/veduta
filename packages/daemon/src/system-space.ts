import { SYSTEM_SPACE_ID, type Space } from '@veduta/protocol'
import type { SpacesEngine } from './spaces-engine.ts'

export { SYSTEM_SPACE_ID } from '@veduta/protocol'
const SYSTEM_SPACE_SLUG = 'system'
const SYSTEM_SPACE_NAME = 'System'

/**
 * Materializes the System Space as a real, persisted Space (issue #14):
 * the trust admin Surfaces (allowlist, audit) need a durable home a
 * user can navigate to, so it is ordinary durable living state. This is a deliberate,
 * documented deviation from "every Space is user-confirmed" (ADR-0002's
 * proposal→confirm flow) — the System Space is daemon-created at boot,
 * not proposed, because it is not a life area the user chose but
 * infrastructure the daemon itself owns.
 */
export function ensureSystemSpace(spacesEngine: SpacesEngine): Space {
  return spacesEngine.ensureSystemSpace({ name: SYSTEM_SPACE_NAME, slug: SYSTEM_SPACE_SLUG })
}
