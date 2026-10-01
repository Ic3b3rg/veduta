import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatTimelinePageSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { ChatTimeline } from './chat-timeline.ts'
import { buildServer } from './server.ts'

describe('authenticated Gateway Chat timeline retrieval', () => {
  it('returns only the requested Space page after a Gateway restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'veduta-chat-routes-'))
    try {
      const first = buildServer({ dataDir: root })
      await first.app.ready()
      const health = first.store.spacesEngine.createSpace({ name: 'Health' })
      const work = first.store.spacesEngine.createSpace({ name: 'Work' })
      const writer = new ChatTimeline(root)
      const accepted = writer.accept({
        submissionId: 'health-message',
        scope: { type: 'space', spaceId: health.id },
        text: 'How is Health?',
      })
      writer.begin(accepted.turnId)
      writer.complete(accepted.turnId, { role: 'assistant', text: 'Health is ready.' })
      writer.close()

      const path = `/api/chat/timeline?spaceId=${health.id}`
      const page = ChatTimelinePageSchema.parse(
        (await first.app.inject({ method: 'GET', url: path })).json(),
      )
      expect(page.entries.map((entry) => entry.message.text)).toEqual([
        'How is Health?',
        'Health is ready.',
      ])
      expect(
        (
          await first.app.inject({ method: 'GET', url: `/api/chat/timeline?spaceId=${work.id}` })
        ).json(),
      ).toMatchObject({ entries: [] })
      expect(
        (await first.app.inject({ method: 'GET', url: '/api/chat/timeline?spaceId=missing' }))
          .statusCode,
      ).toBe(404)
      first.store.spacesEngine.archiveSpace(health.id)
      expect(
        ChatTimelinePageSchema.parse((await first.app.inject({ method: 'GET', url: path })).json())
          .entries,
      ).toEqual(page.entries)
      await first.app.close()

      const second = buildServer({ dataDir: root })
      await second.app.ready()
      const restored = ChatTimelinePageSchema.parse(
        (await second.app.inject({ method: 'GET', url: path })).json(),
      )
      expect(restored.entries).toEqual(page.entries)
      await second.app.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
