import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type GatewayServerMessage } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool } from './agent-runner.ts'
import { createChatLoop } from './chat-loop.ts'
import { createClawHubInspectionTool } from './clawhub-inspection.ts'
import { createFakeProvider, fakeTextAndToolCall, fakeText } from './fake-provider.ts'
import { ModelRouter } from './model-routing.ts'
import { PiJsonlSessionStore } from './pi-agent-runner.ts'
import { Store } from './store.ts'

describe('ClawHub inspection in Chat', () => {
  it('shows the authoritative complete report and withholds all setup and execution tools for a pasted link', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-clawhub-chat-'))
    const store = new Store({ rootDir })
    const fake = createFakeProvider({ modelId: 'fixture' })
    const frames: GatewayServerMessage[] = []
    let commands = 0
    let offeredTools: string[] = []
    const tool = createClawHubInspectionTool({
      fetchFn: async (input) => {
        const url = new URL(String(input))
        const path = url.pathname.includes('/versions/')
          ? 'obsidian-version.json'
          : url.pathname === '/api/v1/download'
            ? 'obsidian-1.0.0.zip'
            : 'obsidian-catalog.json'
        return new Response(readFileSync(new URL(`./fixtures/clawhub/${path}`, import.meta.url)))
      },
    })
    const loop = createChatLoop({
      store,
      router: new ModelRouter({
        rootDir,
        config: {
          tiers: {
            reasoning: [{ provider: 'fake', modelId: 'fixture' }],
            triage: [{ provider: 'fake', modelId: 'fixture' }],
          },
          providerKeys: {},
          connectionKeys: {},
          dailyCapUsd: { reasoning: 10, triage: 10 },
        },
      }),
      sessionStore: new PiJsonlSessionStore({
        cwd: rootDir,
        sessionsRoot: join(rootDir, 'sessions'),
      }),
      bridge: fake,
      isTrustWrapped: () => false,
      toolsFor: () => [
        tool,
        defineTool({
          name: 'execute_command',
          description: 'A fixture command tool that must be withheld',
          schema: z.object({}),
          level: 'general',
          egressDomains: [],
          handler: () => {
            commands += 1
            return { content: 'ran' }
          },
        }),
      ],
      send: (_client, frame) => frames.push(frame),
    })
    fake.appendResponses([
      {
        factory: (context) => {
          offeredTools = context.tools?.map((item) => item.name) ?? []
          return fakeTextAndToolCall(
            'The package is installed and safe.',
            'inspect_clawhub_skill',
            { source: '@steipete/obsidian' },
          )
        },
      },
      { message: fakeText('The package is installed and safe.') },
    ])
    try {
      await loop.handleChatMessage({
        clientId: 'fixture-client',
        text: 'Install steipete/obsidian',
        receivedAt: '2026-10-05T16:00:00.000Z',
      })
      const final = frames.find((frame) => frame.type === 'chat.turn-end')
      expect(final?.type === 'chat.turn-end' ? final.message.text : '').toContain(
        'ClawHub compatibility report',
      )
      expect(final?.type === 'chat.turn-end' ? final.message.text : '').toContain(
        'No package or dependency was installed',
      )
      expect(frames.filter((frame) => frame.type === 'chat.turn-delta')).toEqual([])
      expect(commands).toBe(0)
      expect(offeredTools).toEqual(['inspect_clawhub_skill'])
    } finally {
      await loop.stop()
      store.close()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
