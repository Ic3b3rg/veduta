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

/** Matches a bare `X.Y.Z`, the only shape a signed release ever carries and the only one version comparison accepts. */
const STAMPED_VERSION_RE = /^\d+\.\d+\.\d+$/

/**
 * The version an instance reports and reasons about. A stamped build always
 * wins: once the release build has written a real `X.Y.Z` into
 * `VEDUTA_VERSION`, nothing can override what those signed bytes say they are.
 *
 * An unstamped build — a git checkout, which is exactly what `deploy/install.sh`
 * deploys — resolves to `0.0.0` instead. That is the deliberate baseline: the
 * placeholder is not a comparable version, so without it the very first feed
 * check on an installer-deployed instance would throw and no release could
 * ever be discovered. Treating an unstamped tree as older than every release
 * makes the first signed release discoverable, which is the honest reading of
 * "this build was never released".
 *
 * `VEDUTA_INSTALLED_VERSION` only fills in for that baseline, never over a
 * stamped release, and only when it is itself a valid triple: it exists so the
 * e2e harness (`packages/e2e/tests/self-update.spec.ts`) can stand an
 * unstamped checkout up as a concrete older version and exercise the real
 * comparison path.
 */
export function resolveInstalledVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (STAMPED_VERSION_RE.test(VEDUTA_VERSION)) return VEDUTA_VERSION
  const override = env['VEDUTA_INSTALLED_VERSION']
  if (override !== undefined && STAMPED_VERSION_RE.test(override)) return override
  return '0.0.0'
}

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
