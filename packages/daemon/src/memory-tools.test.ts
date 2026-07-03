import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { seedSpaces } from './seed.ts'
import { createMemoryTools } from './memory-tools.ts'
import { SpacesEngine } from './spaces-engine.ts'

describe('memory tools', () => {
  it('exposes write_fact, append_event, read_recent and search_log through ToolDef', async () => {
    const engine = new SpacesEngine({
      rootDir: await tempRoot(),
      now: fixedNow,
      seed: seedSpaces(),
    })
    const tools = createMemoryTools(engine, { activeSpaceId: 'spc-health' })

    const writeFact = requireTool(tools, 'write_fact')
    const written = await writeFact.handler(writeFact.schema.parse({ fact: 'I like rice' }), {
      toolCallId: 'write',
    })

    expect(written.content).toBe('FACTS add: I like rice')
    expect(engine.searchFacts('spc-health', 'rice').map((fact) => fact.text)).toEqual([
      'I like rice',
    ])

    const appendEvent = requireTool(tools, 'append_event')
    await appendEvent.handler(
      appendEvent.schema.parse({ text: 'User logged dinner', type: 'turn' }),
      { toolCallId: 'append' },
    )

    const readRecent = requireTool(tools, 'read_recent')
    const recent = await readRecent.handler(readRecent.schema.parse({ limit: 5 }), {
      toolCallId: 'recent',
    })

    expect(recent.content).toContain('User logged dinner')

    const searchLog = requireTool(tools, 'search_log')
    const searched = await searchLog.handler(searchLog.schema.parse({ query: 'dinner' }), {
      toolCallId: 'search',
    })

    expect(searched.content).toContain('User logged dinner')
  })
})

function requireTool(tools: ReturnType<typeof createMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing tool: ${name}`)
  return tool
}

function fixedNow(): Date {
  return new Date('2026-07-03T12:00:00.000Z')
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'veduta-spaces-'))
}
