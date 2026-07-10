import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { MemorySessionStore, defineTool, type AgentEvent, type ToolDef } from './agent-runner.ts'
import { MockAgentRunner } from './mock-agent-runner.ts'

const readTool: ToolDef = defineTool({
  name: 'read_recent',
  description: 'read-only',
  schema: z.object({}),
  level: 'L0',
  handler: () => ({ content: 'ok' }),
})

const sendTool: ToolDef = defineTool({
  name: 'send_email',
  description: 'outbound',
  schema: z.object({}),
  level: 'L1',
  handler: () => ({ content: 'sent' }),
})

describe('MockAgentRunner', () => {
  it('gates tools, stamps the untrusted origin on both messages, and fires turn-end', async () => {
    const store = new MemorySessionStore()
    const runner = new MockAgentRunner(store)
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    await runner.start('session-untrusted')
    await runner.prompt('show the full text of event #1', {
      origin: 'untrusted:gmail',
      tools: [readTool, sendTool],
    })

    expect(runner.lastGatedTools.map((tool) => tool.name)).toEqual(['read_recent'])

    const branch = await store.load('session-untrusted')
    expect(
      branch.messages.map((message) => ({ role: message.role, origin: message.origin })),
    ).toEqual([
      { role: 'user', origin: 'untrusted:gmail' },
      { role: 'assistant', origin: 'untrusted:gmail' },
    ])

    expect(events.map((event) => event.type)).toEqual(['turn-end'])
    const turnEnd = events[0]
    if (turnEnd?.type !== 'turn-end') throw new Error('expected turn-end')
    expect(turnEnd.text).toBe('Displayed the requested content.')
    expect(turnEnd.text).not.toContain('full text')
  })

  it('keeps every tool and leaves messages untainted for a trusted turn', async () => {
    const store = new MemorySessionStore()
    const runner = new MockAgentRunner(store)
    await runner.start('session-trusted')
    await runner.prompt('hello', { tools: [readTool, sendTool] })

    expect(runner.lastGatedTools.map((tool) => tool.name)).toEqual(['read_recent', 'send_email'])
    const branch = await store.load('session-trusted')
    expect(branch.messages.every((message) => message.origin === undefined)).toBe(true)
  })

  it('emits an error and rejects when prompted before start', async () => {
    const runner = new MockAgentRunner()
    const events: AgentEvent[] = []
    runner.on((event) => {
      events.push(event)
    })

    await expect(runner.prompt('too early')).rejects.toThrow(/start must be called/)
    expect(events.map((event) => event.type)).toEqual(['error'])
  })
})
