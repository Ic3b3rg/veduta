import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadIngestionConfig } from './ingestion-config.ts'
import { buildServer } from './server.ts'
import { signBody } from './webhook-verify.ts'

describe('Gateway legacy personal mail startup', () => {
  const roots: string[] = []

  afterEach(() => {
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('leaves a configured Gmail source passive at boot and on a legacy push', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-passive-gmail-'))
    roots.push(root)
    writeFileSync(
      join(root, 'ingestion.json'),
      JSON.stringify({
        sources: {
          gmail: {
            verification: 'channel-token',
            secret: 'secret://env/VEDUTA_MAIL_TEST_CHANNEL_TOKEN',
            spaceId: 'spc-health',
            adapter: 'gmail-push',
            gmail: {
              topicName: 'projects/test/topics/mail',
              subscription: 'projects/test/subscriptions/mail',
            },
            google: {
              clientIdRef: 'secret://env/VEDUTA_MAIL_TEST_CLIENT_ID',
              clientSecretRef: 'secret://env/VEDUTA_MAIL_TEST_CLIENT_SECRET',
              refreshTokenRef: 'secret://env/VEDUTA_MAIL_TEST_REFRESH_TOKEN',
            },
          },
        },
      }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))
    const { app, ingestion, watchManager, store } = buildServer({ dataDir: root })

    try {
      await watchManager.sweep()
      const eventsBefore = store.eventLog('spc-health')
      const response = await app.inject({
        method: 'POST',
        url: '/api/ingest/gmail',
        payload: { message: { data: 'e30=' } },
      })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ outcome: 'inactive' })
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(ingestion.queue.pendingEvents()).toHaveLength(0)
      expect(store.eventLog('spc-health')).toEqual(eventsBefore)
    } finally {
      await app.close()
    }
  })

  it('boots and restarts with an archived IMAP IDLE source without activating it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-passive-imap-'))
    roots.push(root)
    writeFileSync(
      join(root, 'ingestion.json'),
      JSON.stringify({
        sources: {
          personal: {
            spaceId: 'spc-health',
            adapter: 'imap-idle',
            imap: {
              host: 'mail.example.test',
              port: 993,
              authMethod: 'AUTH=PLAIN',
              usernameRef: 'secret://env/VEDUTA_MAIL_TEST_USERNAME',
              passwordRef: 'secret://env/VEDUTA_MAIL_TEST_PASSWORD',
            },
          },
        },
      }),
    )
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    for (let boot = 0; boot < 2; boot += 1) {
      const { app, ingestion, watchManager } = buildServer({ dataDir: root })
      try {
        await watchManager.sweep()
        expect(ingestion.queue.pendingEvents()).toHaveLength(0)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(loadIngestionConfig(root).sources.personal).toMatchObject({
          adapter: 'imap-idle',
          imap: {
            host: 'mail.example.test',
            usernameRef: 'secret://env/VEDUTA_MAIL_TEST_USERNAME',
          },
        })
      } finally {
        await app.close()
      }
    }
  })

  it('keeps an independent signed webhook live beside an inactive legacy Gmail source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-passive-mail-hmac-'))
    roots.push(root)
    process.env['VEDUTA_MAIL_PASSIVITY_HMAC'] = 'hmac-test-secret'
    writeFileSync(
      join(root, 'ingestion.json'),
      JSON.stringify({
        sources: {
          gmail: {
            verification: 'channel-token',
            secret: 'secret://env/VEDUTA_MAIL_TEST_CHANNEL_TOKEN',
            spaceId: 'spc-health',
            adapter: 'gmail-push',
            gmail: {
              topicName: 'projects/test/topics/mail',
              subscription: 'projects/test/subscriptions/mail',
            },
            google: {
              clientIdRef: 'secret://env/VEDUTA_MAIL_TEST_CLIENT_ID',
              clientSecretRef: 'secret://env/VEDUTA_MAIL_TEST_CLIENT_SECRET',
              refreshTokenRef: 'secret://env/VEDUTA_MAIL_TEST_REFRESH_TOKEN',
            },
          },
          webhook: {
            verification: 'hmac',
            secret: 'secret://env/VEDUTA_MAIL_PASSIVITY_HMAC',
            spaceId: 'spc-health',
          },
        },
      }),
    )
    const { app, ingestion, store } = buildServer({ dataDir: root })
    try {
      const payload = JSON.stringify({
        id: 'webhook-1',
        type: 'message.received',
        kind: 'email',
        sender: 'anna@example.com',
        subject: 'A signed event',
      })
      const response = await app.inject({
        method: 'POST',
        url: '/api/ingest/webhook',
        headers: {
          'content-type': 'application/json',
          'x-veduta-signature': signBody('hmac-test-secret', Buffer.from(payload)),
        },
        payload,
      })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toMatchObject({ outcome: 'accepted' })
      expect(ingestion.queue.getEvent(1)?.status).toBe('accepted')
      expect(store.eventLog('spc-health').some((event) => event.type === 'ingestion.accept')).toBe(
        true,
      )
    } finally {
      await app.close()
      delete process.env['VEDUTA_MAIL_PASSIVITY_HMAC']
    }
  })
})
