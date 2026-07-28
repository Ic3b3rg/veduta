import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ImportSourceKind } from '@veduta/protocol'
import { defaultRedactor } from './redaction.ts'

/**
 * A secret this module has decided IS safe to move into the vault: it is one of the three providers
 * Veduta has a home for (`routing.json.providerKeys` → `secret://vault/<provider>`). `value` lives
 * only inside this result object, never inside `describeSecrets`' output — `import-apply.ts` needs
 * the literal value to call `storeProviderKey`, but nothing downstream of that call should ever see
 * it again.
 */
export interface ImportableSecret {
  vaultName: string
  sourceKey: string
  sourceFile: string
  value: string
}

/**
 * Result of scanning one legacy source for secrets (`docs/references/04-onboarding-migration.md`
 * §C3: "secrets never migrated implicitly... explicit allowlist, redaction in reports"). Three
 * buckets, never merged, because each gets a different downstream treatment: vault import, a
 * NOTES.md "recreate by hand" line, or a NOTES.md "could not be parsed" line.
 */
export interface SecretScan {
  importable: ImportableSecret[]
  /** Allowlist misses: key names found but not importable — NAMES ONLY, never values. */
  notImportable: { sourceKey: string; sourceFile: string }[]
  /** Lines/entries whose syntax this conservative parser does not support — reported, never guessed at. */
  unsupported: string[]
}

/**
 * The only three secrets Veduta can do anything useful with. `routing.json.providerKeys` only ever
 * points at `secret://vault/anthropic`, `.../openai` or `.../openrouter`
 * (`onboarding-step-byok.ts`) — there is no home for a bot token, an OAuth blob, or a Nous portal
 * password, so importing one would create a vault entry nothing in Veduta ever reads. Keyed by the
 * env-var spelling both Hermes' `.env` and OpenClaw's `openclaw.json` use for these three.
 */
export const SECRET_ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  ANTHROPIC_API_KEY: 'anthropic',
  OPENAI_API_KEY: 'openai',
  OPENROUTER_API_KEY: 'openrouter',
})

const ALLOWLIST_BY_LOWER_KEY = new Map(
  Object.entries(SECRET_ALLOWLIST).map(([key, vaultName]) => [key.toLowerCase(), vaultName]),
)

/**
 * Broader "this looks like a credential" shape (AC): catches a Telegram bot token, an OAuth client
 * secret, a Nous portal password — anything that must never be silently dropped just because it
 * isn't one of the three importable providers. Matched only against the source's own key name,
 * never its value — a key name is not itself a secret.
 */
const CREDENTIAL_LOOKING_KEY_RE = /(api[_-]?key|token|secret|password|credential)/i

type KeyClassification =
  { kind: 'importable'; vaultName: string } | { kind: 'notImportable' } | { kind: 'ignore' }

function classifyKey(key: string): KeyClassification {
  const vaultName = ALLOWLIST_BY_LOWER_KEY.get(key.toLowerCase())
  if (vaultName !== undefined) return { kind: 'importable', vaultName }
  if (CREDENTIAL_LOOKING_KEY_RE.test(key)) return { kind: 'notImportable' }
  return { kind: 'ignore' }
}

const DOTENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Parses a DELIBERATELY conservative subset of `.env` syntax ("unsupported lines reported, never
 * guessed"). Supported: blank lines and full-line `#` comments (ignored); `KEY=value` with an
 * optional leading `export `; a value wrapped in matching single or double quotes, unquoted with NO
 * escape processing (a backslash stays a literal backslash); `KEY` must match
 * `/^[A-Za-z_][A-Za-z0-9_]*$/`. Deliberately NOT supported, and reported instead of guessed at:
 * variable interpolation (`$FOO`, `${FOO}`), multiline/heredoc values, backslash escape sequences,
 * and a line whose quoting never closes (`FOO="bar` with no closing quote). A parser that guessed
 * at any of these would risk turning half a secret into a differently-wrong string, which is worse
 * than refusing. Every unsupported case is reported by key name or line number ONLY — the raw value
 * is stripped before reporting, because an unsupported line can still contain a secret. Exported so
 * `import-secrets.test.ts` can exercise this edge-case-heavy grammar directly, independent of
 * `scanLegacySecrets`' allowlist/redaction wrapping.
 */
export function parseDotEnv(text: string): {
  entries: Map<string, string>
  unsupported: string[]
} {
  const entries = new Map<string, string>()
  const unsupported: string[] = []

  text.split(/\r\n|\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#')) return

    const rest = trimmed.startsWith('export ')
      ? trimmed.slice('export '.length).trimStart()
      : trimmed

    const eq = rest.indexOf('=')
    if (eq === -1) {
      unsupported.push(`line ${lineNumber} (unsupported syntax)`)
      return
    }

    const key = rest.slice(0, eq)
    if (!DOTENV_KEY_RE.test(key)) {
      unsupported.push(`line ${lineNumber} (unsupported syntax)`)
      return
    }

    const value = unquoteDotEnvValue(rest.slice(eq + 1))
    if (value === undefined) {
      unsupported.push(`${key} (unsupported syntax)`)
      return
    }

    entries.set(key, value)
  })

  return { entries, unsupported }
}

/**
 * Strips one layer of matching single/double quotes with no escape
 * processing. `undefined` means the quoting doesn't close cleanly (e.g. an
 * unterminated quote), which the caller must report without the raw value.
 */
function unquoteDotEnvValue(value: string): string | undefined {
  if (value.length === 0) return ''
  const quote = value.charAt(0)
  if (quote !== '"' && quote !== "'") return value
  const inner = value.slice(1, -1)
  const closes =
    value.length >= 2 && value.charAt(value.length - 1) === quote && !inner.includes(quote)
  return closes ? inner : undefined
}

const OPENCLAW_MAX_DEPTH = 6
const OPENCLAW_MAX_KEYS = 200

/**
 * Recursively walks a parsed `openclaw.json`, collecting only STRING leaves whose own object key
 * looks like a secret. Depth is capped at `OPENCLAW_MAX_DEPTH` and total collected entries at
 * `OPENCLAW_MAX_KEYS` — bounds that exist only so a hostile or pathologically deep/wide config
 * can't spin forever or flood `NOTES.md`; hitting either cap is reported once in `unsupported`,
 * never thrown.
 */
function collectOpenclawSecrets(root: unknown, sourceFile: string): SecretScan {
  const importable: ImportableSecret[] = []
  const notImportable: { sourceKey: string; sourceFile: string }[] = []
  const unsupported: string[] = []
  let collected = 0
  let depthOverflowReported = false
  let keyOverflowReported = false

  const visit = (node: unknown, key: string | undefined, depth: number): void => {
    if (keyOverflowReported) return

    if (depth > OPENCLAW_MAX_DEPTH) {
      if (!depthOverflowReported) {
        depthOverflowReported = true
        unsupported.push(`${sourceFile} (recursion depth limit of ${OPENCLAW_MAX_DEPTH} exceeded)`)
      }
      return
    }

    if (typeof node === 'string') {
      if (key === undefined) return
      const classification = classifyKey(key)
      if (classification.kind === 'ignore') return

      if (collected >= OPENCLAW_MAX_KEYS) {
        if (!keyOverflowReported) {
          keyOverflowReported = true
          unsupported.push(
            `${sourceFile} (exceeded ${OPENCLAW_MAX_KEYS} collected keys, stopping scan)`,
          )
        }
        return
      }
      collected += 1

      if (classification.kind === 'importable') {
        defaultRedactor.register(node)
        importable.push({
          vaultName: classification.vaultName,
          sourceKey: key,
          sourceFile,
          value: node,
        })
      } else {
        // register the value even though it is not importable — see the
        // matching comment in `scanHermesSecrets`.
        defaultRedactor.register(node)
        notImportable.push({ sourceKey: key, sourceFile })
      }
      return
    }

    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, depth + 1)
      return
    }

    if (node !== null && typeof node === 'object') {
      for (const [childKey, childValue] of Object.entries(node as Record<string, unknown>)) {
        visit(childValue, childKey, depth + 1)
      }
    }
  }

  visit(root, undefined, 0)
  return { importable, notImportable, unsupported }
}

function scanHermesSecrets(dir: string): SecretScan {
  const importable: ImportableSecret[] = []
  const notImportable: { sourceKey: string; sourceFile: string }[] = []
  const unsupported: string[] = []

  const envPath = join(dir, '.env')
  if (existsSync(envPath)) {
    const { entries, unsupported: envUnsupported } = parseDotEnv(readFileSync(envPath, 'utf8'))
    for (const message of envUnsupported) unsupported.push(`.env: ${message}`)

    for (const [key, value] of entries) {
      const classification = classifyKey(key)
      if (classification.kind === 'importable') {
        defaultRedactor.register(value)
        importable.push({
          vaultName: classification.vaultName,
          sourceKey: key,
          sourceFile: '.env',
          value,
        })
      } else if (classification.kind === 'notImportable') {
        // a Telegram bot token, an OAuth client secret, etc. is never
        // importable (no home for it in `routing.json`), but its VALUE must
        // still be registered — otherwise the same string, pasted into
        // someone's MEMORY.md prose, reaches FACTS/the Event log/the archive
        // unredacted, since `redaction.ts`'s built-in patterns only cover
        // `sk-…`/`Bearer …`/`AKIA…` shapes, not an arbitrary bot token.
        defaultRedactor.register(value)
        notImportable.push({ sourceKey: key, sourceFile: '.env' })
      }
    }
  }

  // Hermes' own guideline: `.env` is secrets only, `auth.json` is OAuth
  // credentials with an entirely different shape. Recorded by name, never
  // opened or parsed (§"Hermes" table).
  if (existsSync(join(dir, 'auth.json'))) {
    notImportable.push({ sourceKey: 'auth.json (OAuth credentials)', sourceFile: 'auth.json' })
  }

  return { importable, notImportable, unsupported }
}

function scanOpenclawSecrets(dir: string): SecretScan {
  const configPath = join(dir, 'openclaw.json')
  if (!existsSync(configPath)) return { importable: [], notImportable: [], unsupported: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { importable: [], notImportable: [], unsupported: ['openclaw.json (malformed JSON)'] }
  }

  return collectOpenclawSecrets(parsed, 'openclaw.json')
}

/**
 * Scans one legacy source directory for the only secrets Veduta can import
 *. Read-only and tolerant of absence: a
 * missing `.env`/`openclaw.json`/`auth.json` simply yields nothing, never an
 * error, matching the discovery discipline the rest of the importer uses
 * for optional files. A malformed `openclaw.json` is reported in
 * `unsupported`, never thrown. Every value that lands in `importable` is
 * registered with `defaultRedactor` before this function returns, so it can
 * never survive into a log line, an error message, or the Event log from
 * this point on.
 */
export function scanLegacySecrets(input: { kind: ImportSourceKind; dir: string }): SecretScan {
  return input.kind === 'hermes' ? scanHermesSecrets(input.dir) : scanOpenclawSecrets(input.dir)
}

// `describeSecrets` was deleted here: it was a second rendering of
// exactly what `buildImportPlan` (`import-plan.ts`) already produces —
// `scan.notImportable`/`scan.unsupported` reach the user through
// `plan.notMigrated` instead. The CLI's `import-preview-text.ts` (owned by
// another work stream) called this function and must switch to rendering
// `plan.items`/`plan.notMigrated` directly.
