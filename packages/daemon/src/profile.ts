import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The Local VPS profile's default base directory (issue 023): deliberately
 * under the user's home, never the repository, so a bare run can never leave
 * auth state or Event logs somewhere a `git add` could pick up. The runner
 * (`deploy/local-vps.sh`) provisions the same layout — `data/` plus a
 * `vault.key` sibling kept OUTSIDE the data root so backups of the data
 * directory never contain the key that decrypts them.
 */
const LOCAL_VPS_BASE_DIR = '.veduta-local-vps'

/**
 * The daemon's execution profile (issue 023, `docs/adr/0009-local-vps-profile.md`):
 * `loopback` is today's `pnpm dev` default (no auth, mock provider), `vps` is
 * a real deployment behind a public domain with ACME/TLS, and `local-vps` is
 * the profile this issue adds — real passkey auth over `http://localhost`
 * instead of a public domain, so core production flows can be rehearsed on a
 * laptop.
 */
export type ResolvedProfile =
  | { profile: 'loopback' }
  | { profile: 'vps' }
  | {
      profile: 'local-vps'
      port: number
      origin: string
      dataDir: string
      vaultKeyfile: string | undefined
    }

/**
 * Picks the execution profile from environment variables. Pure aside from
 * the injectable `fileExists` check (defaults to `existsSync`), used only to
 * decide whether a Local VPS profile vault keyfile is present at its default
 * path — tests supply a fake so this function never touches the real
 * filesystem, and a bare boot with no keyfile there runs with the vault off
 * rather than failing (`secrets-vault.ts`'s `resolveVaultKeyMaterial` treats
 * missing key material as "no vault yet", not an error).
 *
 * `VEDUTA_PROFILE=local-vps` together with `VEDUTA_PUBLIC_DOMAIN` is
 * rejected as ambiguous (a public domain implies the `vps` profile, which
 * the Local VPS profile's whole point is to stand in for), as is any
 * `VEDUTA_PROFILE` value outside `loopback` / `local-vps` / `vps`.
 * `VEDUTA_PROFILE=vps` without `VEDUTA_PUBLIC_DOMAIN` is rejected too: an
 * explicit request for the authenticated profile must never silently fall
 * through to loopback's unauthenticated boot.
 */
export function resolveProfile(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): ResolvedProfile {
  const requested = env['VEDUTA_PROFILE']
  const domain = env['VEDUTA_PUBLIC_DOMAIN']

  if (
    requested !== undefined &&
    requested !== 'loopback' &&
    requested !== 'local-vps' &&
    requested !== 'vps'
  ) {
    throw new Error(`unknown VEDUTA_PROFILE: ${requested} (expected loopback, local-vps, or vps)`)
  }

  if (requested === 'local-vps') {
    if (domain) {
      throw new Error(
        'VEDUTA_PROFILE=local-vps is incompatible with VEDUTA_PUBLIC_DOMAIN: the Local VPS profile ' +
          'is a local substitute for the vps profile a public domain implies, not a variant of it',
      )
    }
    const port = Number(env['PORT'] ?? 8788)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `PORT must be an integer between 1 and 65535 for the Local VPS profile, got: ${env['PORT']}`,
      )
    }
    return {
      profile: 'local-vps',
      port,
      origin: `http://localhost:${port}`,
      dataDir: env['VEDUTA_DATA_DIR'] ?? join(homedir(), LOCAL_VPS_BASE_DIR, 'data'),
      vaultKeyfile: resolveDefaultVaultKeyfile(env, fileExists),
    }
  }

  if (requested === 'loopback') return { profile: 'loopback' }

  if (requested === 'vps') {
    if (!domain) {
      throw new Error('VEDUTA_PROFILE=vps requires VEDUTA_PUBLIC_DOMAIN')
    }
    return { profile: 'vps' }
  }

  // `VEDUTA_PROFILE=loopback` with VEDUTA_PUBLIC_DOMAIN still set is allowed
  // on purpose: it is the explicit escape hatch to boot the unauthenticated
  // loopback profile on a host whose environment carries a domain (e.g. a
  // VPS shell where the operator wants a quick local check) — explicit
  // `loopback` can never be a surprise, unlike the silent fall-through that
  // `VEDUTA_PROFILE=vps` without a domain used to have.
  return domain ? { profile: 'vps' } : { profile: 'loopback' }
}

/**
 * The Local VPS profile's vault keyfile: env wins when the caller already
 * set `VEDUTA_VAULT_KEYFILE` or `VEDUTA_VAULT_KEY` (`secrets-vault.ts`'s
 * `resolveVaultKeyMaterial` reads those directly), otherwise the profile's
 * own default path, but only if a file actually exists there — a fresh
 * install with no keyfile yet must boot with the vault off, not throw.
 * The default stays under the home base dir even when `VEDUTA_DATA_DIR`
 * relocates the data root: the key must live outside whatever directory
 * gets backed up, and a caller relocating the data root is expected to
 * relocate the key explicitly too (the runner always passes both).
 */
function resolveDefaultVaultKeyfile(
  env: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean,
): string | undefined {
  if (env['VEDUTA_VAULT_KEYFILE'] || env['VEDUTA_VAULT_KEY']) return undefined
  const defaultPath = join(homedir(), LOCAL_VPS_BASE_DIR, 'vault.key')
  return fileExists(defaultPath) ? defaultPath : undefined
}
