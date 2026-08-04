/**
 * The daemon's own version. The source tree always carries this
 * placeholder — the release build (issue #43,
 * `docs/adr/0013-signed-self-update.md`, "Amendments (issue #43
 * implementation)") stamps the real `X.Y.Z` release version into the
 * artifact's own copy of this file before signing, so a running instance's
 * `/api/health` reports what it was actually released as. `pnpm dev` and
 * every test always see this literal value.
 */
export const VEDUTA_VERSION = '0.0.0-dev'

/**
 * Numeric x.y.z triple compare, tolerant of a leading `v` (the update
 * feed's release tags are `vX.Y.Z`). Returns -1/0/1 the way
 * `Array.prototype.sort` expects. The updater uses this to enforce
 * monotonicity — offered version strictly greater than installed —
 * independent of what the feed claims (`docs/adr/0013-signed-self-update.md`'s
 * "Amendments" section).
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const [aMajor, aMinor, aPatch] = parseVersionTriple(a)
  const [bMajor, bMinor, bPatch] = parseVersionTriple(b)
  if (aMajor !== bMajor) return aMajor < bMajor ? -1 : 1
  if (aMinor !== bMinor) return aMinor < bMinor ? -1 : 1
  if (aPatch !== bPatch) return aPatch < bPatch ? -1 : 1
  return 0
}

function parseVersionTriple(version: string): readonly [number, number, number] {
  const stripped = version.startsWith('v') ? version.slice(1) : version
  const parts = stripped.split('.')
  const major = Number(parts[0])
  const minor = Number(parts[1])
  const patch = Number(parts[2])
  const isValid =
    parts.length === 3 &&
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch)
  if (!isValid) throw new Error(`compareVersions: "${version}" is not an x.y.z version`)
  return [major, minor, patch]
}
