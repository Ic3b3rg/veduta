import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { MemorySessionStore, defineTool, type AgentEvent, type ToolDef } from './agent-runner.ts'
import { MockAgentRunner } from './mock-agent-runner.ts'
import { gateToolsForOrigins } from './taint.ts'

const readTool: ToolDef = defineTool({
  name: 'read_recent',
  description: 'read-only',
  schema: z.object({}),
  level: 'L0',
  egressDomains: [],
  handler: () => ({ content: 'ok' }),
})

const sendTool: ToolDef = defineTool({
  name: 'send_email',
  description: 'outbound',
  schema: z.object({}),
  level: 'L1',
  egressDomains: ['mail.example.com'],
  handler: () => ({ content: 'sent' }),
})

const deleteTool: ToolDef = defineTool({
  name: 'delete_account',
  description: 'never automatic',
  schema: z.object({}),
  level: 'L2',
  egressDomains: [],
  handler: () => ({ content: 'deleted' }),
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

describe('MockAgentRunner with isToolTrustWrapped (D5)', () => {
  it('admits a wrapped L1 tool even in a tainted turn, but still strips an unwrapped L2 tool', async () => {
    const runner = new MockAgentRunner(new MemorySessionStore(), {
      isToolTrustWrapped: (tool) => tool.name === 'send_email',
    })
    await runner.start('session-wrapped')
    await runner.prompt('reply to the email', {
      origin: 'untrusted:gmail',
      tools: [readTool, sendTool, deleteTool],
    })

    expect(runner.lastGatedTools.map((tool) => tool.name)).toEqual(['read_recent', 'send_email'])
  })

  it('falls back to fail-closed, taint-only gating without the predicate', async () => {
    const runner = new MockAgentRunner()
    await runner.start('session-unwrapped')
    await runner.prompt('reply to the email', {
      origin: 'untrusted:gmail',
      tools: [readTool, sendTool],
    })

    expect(runner.lastGatedTools.map((tool) => tool.name)).toEqual(['read_recent'])
  })
})

describe('MockAgentRunner.runTool (D10 taint accumulation)', () => {
  it('grows the live taint accumulator from a tool result, visible to a later gating/decision consumer', async () => {
    const store = new MemorySessionStore()
    const runner = new MockAgentRunner(store)
    await runner.start('session-mid-taint')
    await runner.prompt('what happened recently?', { tools: [readTool, sendTool] })

    // The turn started fully trusted: both tools are admitted, and the
    // taint accumulator is seeded with only the trusted prompt origin.
    expect(runner.lastGatedTools.map((tool) => tool.name)).toEqual(['read_recent', 'send_email'])
    expect(runner.taint.origins()).toEqual(['trusted:user'])

    const leakyReadTool: ToolDef = defineTool({
      name: 'read_recent',
      description: 'read-only',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'an untrusted event', origins: ['untrusted:gmail'] }),
    })

    await runner.runTool(leakyReadTool, {}, 'call-1')

    expect(runner.taint.origins()).toEqual(['trusted:user', 'untrusted:gmail'])

    // A later gating/decision consumer reading the *live* taint (not the
    // turn-start snapshot) must now treat the turn as tainted, even though
    // it started trusted.
    const regated = gateToolsForOrigins([readTool, sendTool], runner.taint.origins())
    expect(regated.map((tool) => tool.name)).toEqual(['read_recent'])

    const branch = await store.load('session-mid-taint')
    const toolMessage = branch.messages.find((message) => message.toolCallId === 'call-1')
    expect(toolMessage?.origins).toEqual(['untrusted:gmail'])
    expect(toolMessage?.origin).toBe('untrusted:gmail')
  })
})

describe('MockAgentRunner.contextHash (BINDING amendment A3)', () => {
  it('is present at turn start, stable across dispatches with an unchanged context, and changes once a tool result grows the session', async () => {
    const store = new MemorySessionStore()
    const runner = new MockAgentRunner(store)
    await runner.start('session-hash')
    await runner.prompt('hello', { tools: [readTool] })

    // Present at turn start (computed before the user/assistant messages
    // are even appended, per A3's "and at turn start").
    expect(runner.contextHash).toMatch(/^[0-9a-f]{64}$/)

    const noopTool: ToolDef = defineTool({
      name: 'read_recent',
      description: 'read-only',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'no new provenance' }),
    })
    await runner.runTool(noopTool, {}, 'call-noop-1')
    const stable = runner.contextHash
    await runner.runTool(noopTool, {}, 'call-noop-2')
    // Two dispatches back to back with no reported `origins` in between:
    // nothing was appended to the session, so the hash recomputed before
    // each dispatch is identical.
    expect(runner.contextHash).toBe(stable)

    const leakyTool: ToolDef = defineTool({
      name: 'read_recent',
      description: 'read-only',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'grew the context', origins: ['untrusted:gmail'] }),
    })
    await runner.runTool(leakyTool, {}, 'call-grow')

    // The tool message just appended extends the session: the hash
    // recomputed after this dispatch must differ from the stable one above.
    expect(runner.contextHash).not.toBe(stable)
  })
})
