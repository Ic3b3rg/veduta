import { z } from 'zod'

/**
 * The canonical bytes that get minisign-signed for a release (issue #43,
 * `docs/adr/0013-signed-self-update.md`: the signing key signs the artifact
 * name and contents together with the required data/Node versions).
 * `UpdateManifestSchema` and `UpdateMarkerSchema` both carry this exact JSON
 * base64-encoded — never re-serialized — so `releaseSig` verifies over the
 * identical bytes the signing key actually signed. Node runtime bounds
 * (`nodeVersion`, `nodeTarSize`, `nodeUnpackedSize`) are signed alongside the
 * artifact so a runtime jump is preflightable before any download starts,
 * and `notes` carries the release's user-facing description into the Update
 * Surface.
 *
 * `nodeSha256` anchors the runtime to this signed metadata. Without it the
 * runtime's integrity would rest only on the `SHASUMS256.txt` fetched from the
 * same host over the same channel as the download itself, which a compromised
 * mirror or CDN defeats — sizes alone cannot catch a substituted tarball. It is
 * optional so a manifest produced before the field existed still parses; the
 * updater then falls back to the weaker same-host checksum and says so.
 */
export const ReleaseMetadataSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'version must be an x.y.z triple'),
  artifactName: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  artifactSize: z.number().int().positive(),
  unpackedSize: z.number().int().positive(),
  entryCount: z.number().int().positive(),
  dataVersion: z.number().int().min(1),
  nodeVersion: z.string().min(1),
  nodeTarSize: z.number().int().positive(),
  nodeUnpackedSize: z.number().int().positive(),
  nodeSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'nodeSha256 must be 64 lowercase hex characters')
    .optional(),
  notes: z.string().default(''),
})

/**
 * One key in the two-tier minisign chain (`docs/adr/0013-signed-self-update.md`):
 * the daily signing key's own pubkey/cert file text, root-signed, plus a
 * `keyId` so a future key rotation needs no format change. `pub` and
 * `rootSig` are the verbatim contents of the minisign pubkey/signature
 * files, not derived fields — the verifier parses them the same way it
 * parses any other minisign file.
 */
export const SigningKeyCertSchema = z.object({
  pub: z.string().min(1),
  rootSig: z.string().min(1),
  keyId: z.string().min(1),
})

/**
 * `stable.json` — the gated update feed the maintainer promotes soaked
 * releases into (`docs/adr/0013-signed-self-update.md`). `release` is the
 * exact signed `ReleaseMetadataSchema` JSON bytes, base64-encoded, so
 * `releaseSig` verifies over the identical bytes that were signed; decoding
 * and re-serializing the object before checking the signature would break
 * verification the moment key ordering or whitespace differs.
 */
export const UpdateManifestSchema = z.object({
  schemaVersion: z.literal(1),
  release: z.string().base64(),
  releaseSig: z.string().min(1),
  signingKey: SigningKeyCertSchema,
  artifactUrl: z.string().url(),
})

/**
 * `/etc/veduta/update.json` — the root-owned trust anchors pinned at
 * install time (`docs/adr/0013-signed-self-update.md`'s "Amendments" section):
 * the feed to poll and the offline root public key every signing-key
 * certificate must chain to. Written only by the installer; a compromised
 * daemon must never be able to repoint either value.
 */
export const UpdatePinningSchema = z.object({
  feedUrl: z.string().url(),
  rootPublicKey: z.string().min(1),
})

/**
 * The marker the daemon writes on "Apply" (the Update Surface, issue #43)
 * and the wrapper consumes at transaction start: the verified offer, frozen
 * at apply time. Shape mirrors `UpdateManifestSchema` minus `schemaVersion`
 * plus `requestedAt`, so a feed change after the marker was written can
 * never retroactively swap what gets installed.
 */
export const UpdateMarkerSchema = z.object({
  requestedAt: z.string().datetime(),
  release: z.string().base64(),
  releaseSig: z.string().min(1),
  signingKey: SigningKeyCertSchema,
  artifactUrl: z.string().url(),
})

/**
 * The terminal outcome of one update transaction, published to
 * `state/result.json` (`docs/adr/0013-signed-self-update.md`'s automatic
 * rollback sequence) and ingested by the daemon as an `update.outcome`
 * System Space event. `reason` defaults to `''` for the `success` outcome,
 * where there is nothing to explain; `failedStage` is only present for
 * `refused`/`rolled-back`.
 */
export const UpdateResultSchema = z.object({
  id: z.string().min(1),
  outcome: z.enum(['success', 'refused', 'rolled-back']),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  reason: z.string().default(''),
  finishedAt: z.string().datetime(),
  failedStage: z.string().min(1).optional(),
})

/** Mirrors `InstallerStageStatusSchema` (`onboarding.ts`) — same five states, different protocol. */
export const UpdateStageStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'skipped'])

export const UpdateStageSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: UpdateStageStatusSchema,
})

/**
 * `state/progress.json` — post-hoc stage reporting for a mid-update
 * transaction (`docs/adr/0013-signed-self-update.md`): the daemon that
 * requested the update is down for the whole window, so this can only ever
 * be read after the fact, never polled live. Deliberately the same
 * stage-protocol idiom as
 * `InstallerStageEventSchema` (`onboarding.ts`, issue 019) rather than a
 * shared import — this module has zero dependencies besides zod, and the
 * two protocols (installer vs. self-update) are free to evolve
 * independently.
 */
export const UpdateProgressSchema = z.object({
  protocol_version: z.literal(1),
  stages: z.array(UpdateStageSchema).min(1),
})

export type ReleaseMetadata = z.infer<typeof ReleaseMetadataSchema>
export type SigningKeyCert = z.infer<typeof SigningKeyCertSchema>
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>
export type UpdatePinning = z.infer<typeof UpdatePinningSchema>
export type UpdateMarker = z.infer<typeof UpdateMarkerSchema>
export type UpdateResult = z.infer<typeof UpdateResultSchema>
export type UpdateStageStatus = z.infer<typeof UpdateStageStatusSchema>
export type UpdateStage = z.infer<typeof UpdateStageSchema>
export type UpdateProgress = z.infer<typeof UpdateProgressSchema>
