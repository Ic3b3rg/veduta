import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IngestionConfigSchema, loadIngestionConfig } from './ingestion-config.ts'

describe('loadIngestionConfig', () => {
  let rootDir: string

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'veduta-ingestion-config-'))
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  it('defaults to zero sources: every ingress is an explicit decision', () => {
    expect(loadIngestionConfig(rootDir)).toEqual({ sources: {} })
  })

  it('parses a webhook source with defaults applied', () => {
    writeFileSync(
      join(rootDir, 'ingestion.json'),
      JSON.stringify({
        sources: {
          mail: {
            verification: 'hmac',
            secret: 'secret://env/MAIL_WEBHOOK_SECRET',
            spaceId: 'spc-health',
            filters: { blockSenders: ['@spam.example'] },
          },
        },
      }),
    )
    const config = loadIngestionConfig(rootDir)
    const mail = config.sources['mail']
    expect(mail?.adapter).toBe('webhook')
    expect(mail?.ratePerMinute).toBe(60)
    expect(mail?.filters.discardNewsletters).toBe(true)
    expect(mail?.filters.blockSenders).toEqual(['@spam.example'])
  })

  it('rejects plaintext secrets', () => {
    writeFileSync(
      join(rootDir, 'ingestion.json'),
      JSON.stringify({
        sources: {
          mail: { verification: 'hmac', secret: 'hunter2', spaceId: 'spc-health' },
        },
      }),
    )
    expect(() => loadIngestionConfig(rootDir)).toThrow(/secret:\/\//)
  })

  it('rejects invalid JSON with the offending path in the message', () => {
    writeFileSync(join(rootDir, 'ingestion.json'), '{nope')
    expect(() => loadIngestionConfig(rootDir)).toThrow(/invalid JSON in ingestion config/)
  })

  it('requires gmail and google settings on gmail-push sources', () => {
    expect(() =>
      IngestionConfigSchema.parse({
        sources: {
          gmail: {
            verification: 'query-token',
            secret: 'secret://env/PUSH_TOKEN',
            spaceId: 'spc-health',
            adapter: 'gmail-push',
          },
        },
      }),
    ).toThrow(/gmail-push sources need/)
  })

  it('requires calendar and google settings on calendar-push sources', () => {
    expect(() =>
      IngestionConfigSchema.parse({
        sources: {
          calendar: {
            verification: 'channel-token',
            secret: 'secret://env/CHANNEL_TOKEN',
            spaceId: 'spc-health',
            adapter: 'calendar-push',
          },
        },
      }),
    ).toThrow(/calendar-push sources need/)
  })
})
