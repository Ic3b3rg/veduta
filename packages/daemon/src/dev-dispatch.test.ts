import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, type ToolContext, type ToolDef } from './agent-runner.ts'
import type { NormalizedChannelEvent } from './channel-adapter.ts'
import { createDevDispatch } from './dev-dispatch.ts'
import { createOutboundTools, type OutboundTransport } from './outbound-tools.ts'
import { seedSpaces } from './seed.ts'
import { SpacesEngine } from './spaces-engine.ts'

// Every tempEngine() call creates its own on-disk data dir; tracked here so
// `afterEach` can remove them instead of leaking one per test run (Fix D).
const createdRootDirs: string[] = []

async function tempEngine(): Promise<SpacesEngine> {
  const rootDir = await mkdtemp(join(tmpdir(), 'veduta-dev-dispatch-'))
  createdRootDirs.push(rootDir)
  return new SpacesEngine({ rootDir, seed: seedSpaces() })
}

afterEach(() => {
  for (const dir of createdRootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Records every delivery it receives, mirroring outbound-tools.test.ts's fake. */
class RecordingTransport implements OutboundTransport {
  readonly deliveries: { effectId: string; tool: string; payload: Record<string, unknown> }[] = []

  async deliver(delivery: {
    effectId: string
    tool: string
    payload: Record<string, unknown>
  }): Promise<void> {
    this.deliveries.push(delivery)
  }
}

function chatEvent(text: string, spaceId?: string): NormalizedChannelEvent {
  return {
    adapterId: 'pwa',
    clientId: 'pwa-1',
    text,
    receivedAt: new Date().toISOString(),
    ...(spaceId === undefined ? {} : { spaceId }),
  }
}

/** Flushes the microtask queue past `createDevDispatch`'s fire-and-forget async work. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('createDevDispatch', () => {
  it('parses "send to <addr>: <text>" and invokes send_message', async () => {
    const engine = await tempEngine()
    const transport = new RecordingTransport()
    const tools = createOutboundTools(transport).map((registration) => registration.tool)
    const replies: [string, string][] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools,
      isTrustWrapped: () => true,
      reply: (clientId, text) => replies.push([clientId, text]),
    })

    dispatch(chatEvent('send to alice@example.com: hello there', 'spc-health'))
    await flush()

    expect(transport.deliveries).toHaveLength(1)
    expect(transport.deliveries[0]).toMatchObject({
      tool: 'send_message',
      payload: { to: 'alice@example.com', body: 'hello there', spaceId: 'spc-health' },
    })
    expect(replies).toHaveLength(1)
    expect(replies[0]?.[0]).toBe('pwa-1')
    expect(replies[0]?.[1]).toContain('alice@example.com')
  })

  it('parses "transfer <amount> to <addr>" and invokes transfer_funds', async () => {
    const engine = await tempEngine()
    const transport = new RecordingTransport()
    const tools = createOutboundTools(transport).map((registration) => registration.tool)
    const replies: string[] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools,
      isTrustWrapped: () => true,
      reply: (_clientId, text) => replies.push(text),
    })

    dispatch(chatEvent('transfer 10 to iban-1', 'spc-health'))
    await flush()

    expect(transport.deliveries).toHaveLength(1)
    expect(transport.deliveries[0]).toMatchObject({
      tool: 'transfer_funds',
      payload: { to: 'iban-1', amount: 10, spaceId: 'spc-health' },
    })
    expect(replies[0]).toContain('iban-1')
  })

  it('ignores chat text that matches neither recognized command', async () => {
    const engine = await tempEngine()
    const transport = new RecordingTransport()
    const tools = createOutboundTools(transport).map((registration) => registration.tool)
    const replies: string[] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools,
      isTrustWrapped: () => true,
      reply: (_clientId, text) => replies.push(text),
    })

    dispatch(chatEvent('hello there, nothing to do', 'spc-health'))
    await flush()

    expect(replies).toHaveLength(0)
    expect(transport.deliveries).toHaveLength(0)
  })

  it('replies that a Space is needed when the chat event carries none', async () => {
    const engine = await tempEngine()
    const transport = new RecordingTransport()
    const tools = createOutboundTools(transport).map((registration) => registration.tool)
    const replies: string[] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools,
      isTrustWrapped: () => true,
      reply: (_clientId, text) => replies.push(text),
    })

    dispatch(chatEvent('send to alice@example.com: hi')) // no spaceId
    await flush()

    expect(transport.deliveries).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toMatch(/Space/)
  })

  it('replies "not available" when the tool is stripped by the trust-wrap gate', async () => {
    const engine = await tempEngine()
    const transport = new RecordingTransport()
    const tools = createOutboundTools(transport).map((registration) => registration.tool)
    const replies: string[] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools,
      isTrustWrapped: () => false, // nothing is "wrapped" -> gateToolsForOrigins strips every L1/L2 tool
      reply: (_clientId, text) => replies.push(text),
    })

    dispatch(chatEvent('send to alice@example.com: hi', 'spc-health'))
    await flush()

    expect(transport.deliveries).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('not available')
  })

  it('replies with an invalid-request message when the parsed input fails schema validation', async () => {
    const engine = await tempEngine()
    const transport = new RecordingTransport()
    const tools = createOutboundTools(transport).map((registration) => registration.tool)
    const replies: string[] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools,
      isTrustWrapped: () => true,
      reply: (_clientId, text) => replies.push(text),
    })

    // transfer_funds requires a positive amount; "0" fails schema validation.
    dispatch(chatEvent('transfer 0 to iban-1', 'spc-health'))
    await flush()

    expect(transport.deliveries).toHaveLength(0)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toContain('valid')
  })

  it('builds a ToolContext carrying the seeded taint, spaceId, and chat trigger', async () => {
    const engine = await tempEngine()
    // Taints spc-health's context: contextOrigins() picks up every recent event's origin.
    engine.appendEvent('spc-health', {
      type: 'test.tainted',
      text: 'an untrusted event',
      origin: 'untrusted:gmail',
    })

    let captured: ToolContext | undefined
    const fakeSendMessage: ToolDef = defineTool({
      name: 'send_message',
      description: 'fake send_message for context assertions',
      schema: z.object({ to: z.string(), body: z.string() }),
      level: 'L1',
      egressDomains: [],
      handler: (_input, context) => {
        captured = context
        return { content: 'ok' }
      },
    })

    const replies: string[] = []
    const dispatch = createDevDispatch({
      spacesEngine: engine,
      tools: [fakeSendMessage],
      isTrustWrapped: () => true,
      reply: (_clientId, text) => replies.push(text),
    })

    dispatch(chatEvent('send to alice@example.com: hi', 'spc-health'))
    await flush()

    expect(replies).toEqual(['ok'])
    expect(captured?.spaceId).toBe('spc-health')
    expect(captured?.trigger).toEqual({ kind: 'chat', summary: 'send to alice@example.com: hi' })
    expect(captured?.origin).toBe('untrusted:gmail')
    expect(captured?.origins).toEqual(expect.arrayContaining(['trusted:user', 'untrusted:gmail']))
    expect(captured?.taint.origins()).toEqual(
      expect.arrayContaining(['trusted:user', 'untrusted:gmail']),
    )
    expect(typeof captured?.contextHash).toBe('string')
    expect(captured?.contextHash.length).toBeGreaterThan(0)
  })
})
