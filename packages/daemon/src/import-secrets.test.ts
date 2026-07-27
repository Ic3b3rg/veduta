import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseDotEnv,
  scanLegacySecrets,
  SECRET_ALLOWLIST,
  type SecretScan,
} from './import-secrets.ts'
import { defaultRedactor } from './redaction.ts'

let dir: string | undefined

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'veduta-import-secrets-'))
  return dir
}

describe('SECRET_ALLOWLIST', () => {
  it('maps exactly the three provider keys to their vault names', () => {
    expect(SECRET_ALLOWLIST).toEqual({
      ANTHROPIC_API_KEY: 'anthropic',
      OPENAI_API_KEY: 'openai',
      OPENROUTER_API_KEY: 'openrouter',
    })
  })
})

describe('parseDotEnv', () => {
  it('parses KEY=value, ignoring blank lines and full-line # comments', () => {
    const { entries, unsupported } = parseDotEnv(
      ['# a comment', '', 'ANTHROPIC_API_KEY=sk-ant-abc123', '   ', '# another comment'].join('\n'),
    )
    expect(entries.get('ANTHROPIC_API_KEY')).toBe('sk-ant-abc123')
    expect(unsupported).toEqual([])
  })

  it('handles a leading "export " and strips matching quotes with no escape processing', () => {
    const { entries, unsupported } = parseDotEnv('export ANTHROPIC_API_KEY="sk-test-value"')
    expect(entries.get('ANTHROPIC_API_KEY')).toBe('sk-test-value')
    expect(unsupported).toEqual([])
  })

  it('a KEY= empty value parses as the empty string', () => {
    const { entries, unsupported } = parseDotEnv('EMPTY_VALUE=')
    expect(entries.get('EMPTY_VALUE')).toBe('')
    expect(unsupported).toEqual([])
  })

  it('an unterminated quote is reported in unsupported without the raw value', () => {
    const { entries, unsupported } = parseDotEnv('BROKEN_QUOTE="never-closes-secret-xyz')
    expect(entries.has('BROKEN_QUOTE')).toBe(false)
    expect(unsupported).toHaveLength(1)
    expect(unsupported[0]).toContain('BROKEN_QUOTE')
    expect(unsupported[0]).not.toContain('never-closes-secret-xyz')
  })

  it('a line with no "=" is reported by line number, never guessed at', () => {
    const { unsupported } = parseDotEnv('this-line-has-no-equals-sign')
    expect(unsupported).toEqual(['line 1 (unsupported syntax)'])
  })

  it('an invalid KEY spelling is reported by line number, not by (possibly sensitive) content', () => {
    const { unsupported, entries } = parseDotEnv('123-not-a-valid-key=some-value')
    expect(entries.size).toBe(0)
    expect(unsupported).toEqual(['line 1 (unsupported syntax)'])
  })
})

describe('scanLegacySecrets — hermes', () => {
  it('finds the three provider keys in .env; a bot token lands in notImportable, never importable', () => {
    const home = freshDir()
    writeFileSync(
      join(home, '.env'),
      [
        '# hermes secrets',
        'ANTHROPIC_API_KEY=sk-ant-hermes-key',
        'OPENAI_API_KEY=sk-openai-hermes-key',
        'OPENROUTER_API_KEY=sk-or-hermes-key',
        'TELEGRAM_BOT_TOKEN=123456:ABC-DEF-hermes-bot',
        '',
      ].join('\n'),
    )

    const scan = scanLegacySecrets({ kind: 'hermes', dir: home })

    expect(scan.importable.map((s) => [s.sourceKey, s.vaultName]).sort()).toEqual(
      [
        ['ANTHROPIC_API_KEY', 'anthropic'],
        ['OPENAI_API_KEY', 'openai'],
        ['OPENROUTER_API_KEY', 'openrouter'],
      ].sort(),
    )
    expect(scan.notImportable.some((n) => n.sourceKey === 'TELEGRAM_BOT_TOKEN')).toBe(true)
    expect(scan.importable.some((s) => s.sourceKey === 'TELEGRAM_BOT_TOKEN')).toBe(false)

    // A9: a not-importable-but-credential-looking value is still registered
    // for redaction, so the same token pasted into MEMORY.md prose is caught.
    expect(defaultRedactor.redactText('leaked 123456:ABC-DEF-hermes-bot')).not.toContain(
      '123456:ABC-DEF-hermes-bot',
    )
  })

  it('records auth.json in notImportable without ever parsing it', () => {
    const home = freshDir()
    writeFileSync(join(home, 'auth.json'), '{not even valid json, never opened as such')

    const scan = scanLegacySecrets({ kind: 'hermes', dir: home })
    expect(scan.notImportable.some((n) => n.sourceFile === 'auth.json')).toBe(true)
    expect(scan.unsupported).toEqual([])
  })

  it('a missing .env / auth.json yields nothing, not an error', () => {
    const home = freshDir()
    const scan = scanLegacySecrets({ kind: 'hermes', dir: home })
    expect(scan).toEqual({ importable: [], notImportable: [], unsupported: [] })
  })

  it('an unsupported .env line is reported, prefixed with the source file', () => {
    const home = freshDir()
    writeFileSync(join(home, '.env'), 'this-line-has-no-equals-sign\n')

    const scan = scanLegacySecrets({ kind: 'hermes', dir: home })
    expect(scan.unsupported).toEqual(['.env: line 1 (unsupported syntax)'])
  })
})

describe('scanLegacySecrets — openclaw', () => {
  it('finds the three provider keys including one nested; a bot token stays notImportable at either flag', () => {
    const home = freshDir()
    writeFileSync(
      join(home, 'openclaw.json'),
      JSON.stringify({
        ANTHROPIC_API_KEY: 'sk-ant-openclaw-top-level',
        providers: {
          nested: {
            OPENAI_API_KEY: 'sk-openai-openclaw-nested',
            OPENROUTER_API_KEY: 'sk-or-openclaw-nested',
          },
        },
        telegram: { BOT_TOKEN: 'openclaw-telegram-bot-token' },
      }),
    )

    const scan = scanLegacySecrets({ kind: 'openclaw', dir: home })

    expect(scan.importable.map((s) => s.vaultName).sort()).toEqual(
      ['anthropic', 'openai', 'openrouter'].sort(),
    )
    expect(scan.notImportable.some((n) => n.sourceKey === 'BOT_TOKEN')).toBe(true)
    expect(scan.importable.some((s) => s.sourceKey === 'BOT_TOKEN')).toBe(false)

    // A9: registered for redaction even though it is not importable.
    expect(defaultRedactor.redactText('leaked openclaw-telegram-bot-token')).not.toContain(
      'openclaw-telegram-bot-token',
    )
  })

  it('matches allowlist keys case-insensitively, arbitrarily nested', () => {
    const home = freshDir()
    writeFileSync(
      join(home, 'openclaw.json'),
      JSON.stringify({ deep: { deeper: { anthropic_api_key: 'sk-ant-lowercase-nested' } } }),
    )

    const scan = scanLegacySecrets({ kind: 'openclaw', dir: home })
    expect(scan.importable).toHaveLength(1)
    expect(scan.importable[0]?.vaultName).toBe('anthropic')
    expect(scan.importable[0]?.sourceKey).toBe('anthropic_api_key')
  })

  it('a malformed openclaw.json is reported in unsupported, never thrown', () => {
    const home = freshDir()
    writeFileSync(join(home, 'openclaw.json'), '{ this is not valid json')

    let scan: SecretScan | undefined
    expect(() => {
      scan = scanLegacySecrets({ kind: 'openclaw', dir: home })
    }).not.toThrow()
    expect(scan?.unsupported.some((m) => m.includes('openclaw.json'))).toBe(true)
    expect(scan?.importable).toEqual([])
  })

  it('a missing openclaw.json yields nothing, not an error', () => {
    const home = freshDir()
    const scan = scanLegacySecrets({ kind: 'openclaw', dir: home })
    expect(scan).toEqual({ importable: [], notImportable: [], unsupported: [] })
  })
})

describe('redaction discipline (the key assertion)', () => {
  it('registers an importable secret value for redaction', () => {
    const home = freshDir()
    const SECRET = 'sk-ant-SUPERSECRET-12345'
    writeFileSync(join(home, '.env'), `ANTHROPIC_API_KEY=${SECRET}\n`)

    scanLegacySecrets({ kind: 'hermes', dir: home })

    expect(defaultRedactor.redactText(`leaked ${SECRET}`)).not.toContain(SECRET)
  })

  it('A9: registers a not-importable, credential-looking value too — not just the three allowlisted providers', () => {
    const home = freshDir()
    // Shaped like a Telegram bot token, and deliberately NOT matching any of
    // `redaction.ts`'s built-in patterns (`sk-…`/`Bearer …`/`AKIA…`) — before
    // A9 this value was found by name only and never registered, so the
    // same string in MEMORY.md prose reached FACTS unredacted.
    const NOT_IMPORTABLE_SECRET = '123456789:AAHhermesBotTokenNotAllowlisted'
    writeFileSync(join(home, '.env'), `TELEGRAM_BOT_TOKEN=${NOT_IMPORTABLE_SECRET}\n`)

    const scan = scanLegacySecrets({ kind: 'hermes', dir: home })
    expect(scan.importable).toEqual([])
    expect(scan.notImportable.some((n) => n.sourceKey === 'TELEGRAM_BOT_TOKEN')).toBe(true)

    expect(defaultRedactor.redactText(`leaked ${NOT_IMPORTABLE_SECRET}`)).not.toContain(
      NOT_IMPORTABLE_SECRET,
    )
  })
})
