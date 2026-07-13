import { rmSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { seedSpaces } from './seed.ts'
import { SpacesEngine } from './spaces-engine.ts'
import type { Origin } from './taint.ts'
import {
  createMockOutboundTransport,
  createOutboundTools,
  type OutboundTransport,
  sendMessageMeta,
  transferFundsMeta,
} from './outbound-tools.ts'

function toolContext(params: {
  origin: Origin
  spaceId?: string
  toolCallId?: string
}): ToolContext {
  return fromPartial<ToolContext>({
    toolCallId: params.toolCallId ?? 'call-1',
    origin: params.origin,
    ...(params.spaceId !== undefined ? { spaceId: params.spaceId } : {}),
  })
}

/** Records every delivery it receives, for assertions independent of the mock's Space-event side effect. */
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

// Every tempEngine() call creates its own on-disk data dir; tracked here so
// `afterEach` can remove them instead of leaking one per test run (Fix D).
const createdRootDirs: string[] = []

async function tempEngine(): Promise<SpacesEngine> {
  const rootDir = await mkdtemp(join(tmpdir(), 'veduta-outbound-tools-'))
  createdRootDirs.push(rootDir)
  return new SpacesEngine({ rootDir, seed: seedSpaces() })
}

afterEach(() => {
  for (const dir of createdRootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('outbound tools', () => {
  describe('send_message schema', () => {
    it('accepts a well-formed email and non-empty body', () => {
      const [sendMessage] = createOutboundTools(new RecordingTransport())
      const parsed = sendMessage!.tool.schema.safeParse({
        to: 'alice@example.com',
        body: 'hello',
      })
      expect(parsed.success).toBe(true)
    })

    it('rejects a malformed recipient', () => {
      const [sendMessage] = createOutboundTools(new RecordingTransport())
      const parsed = sendMessage!.tool.schema.safeParse({ to: 'not-an-email', body: 'hello' })
      expect(parsed.success).toBe(false)
    })

    it('rejects an empty body', () => {
      const [sendMessage] = createOutboundTools(new RecordingTransport())
      const parsed = sendMessage!.tool.schema.safeParse({ to: 'alice@example.com', body: '' })
      expect(parsed.success).toBe(false)
    })
  })

  describe('transfer_funds schema', () => {
    it('accepts a positive amount and defaults currency to EUR', () => {
      const [, transferFunds] = createOutboundTools(new RecordingTransport())
      const parsed = transferFunds!.tool.schema.parse({ to: 'iban-1', amount: 10 })
      expect(parsed).toEqual({ to: 'iban-1', amount: 10, currency: 'EUR' })
    })

    it('rejects a non-positive amount', () => {
      const [, transferFunds] = createOutboundTools(new RecordingTransport())
      const parsed = transferFunds!.tool.schema.safeParse({ to: 'iban-1', amount: 0 })
      expect(parsed.success).toBe(false)
    })

    it('rejects a currency that is not a 3-letter uppercase code', () => {
      const [, transferFunds] = createOutboundTools(new RecordingTransport())
      const parsed = transferFunds!.tool.schema.safeParse({
        to: 'iban-1',
        amount: 10,
        currency: 'eur',
      })
      expect(parsed.success).toBe(false)
    })
  })

  describe('declared levels and egress', () => {
    it('declares send_message L1 with mail.example.com egress', () => {
      const [sendMessage] = createOutboundTools(new RecordingTransport())
      expect(sendMessage!.tool.level).toBe('L1')
      expect(sendMessage!.tool.egressDomains).toEqual(['mail.example.com'])
    })

    it('declares transfer_funds L2 with bank.example.com egress', () => {
      const [, transferFunds] = createOutboundTools(new RecordingTransport())
      expect(transferFunds!.tool.level).toBe('L2')
      expect(transferFunds!.tool.egressDomains).toEqual(['bank.example.com'])
    })
  })

  describe('handler -> transport wiring', () => {
    it('passes the context effectId through to the transport, and returns a sensible ToolResult', async () => {
      const transport = new RecordingTransport()
      const [sendMessage] = createOutboundTools(transport)
      const input = sendMessage!.tool.schema.parse({ to: 'alice@example.com', body: 'hi there' })
      const result = await sendMessage!.tool.handler(
        input,
        fromPartial<ToolContext>({
          toolCallId: 'call-1',
          effectId: 'effect-42',
          origin: 'trusted:user',
          spaceId: 'spc-health',
        }),
      )

      expect(transport.deliveries).toHaveLength(1)
      expect(transport.deliveries[0]).toMatchObject({
        effectId: 'effect-42',
        tool: 'send_message',
        payload: { to: 'alice@example.com', body: 'hi there', spaceId: 'spc-health' },
      })
      expect(result.content).toContain('alice@example.com')
    })

    it('falls back to toolCallId as the effectId when context has none', async () => {
      const transport = new RecordingTransport()
      const [sendMessage] = createOutboundTools(transport)
      const input = sendMessage!.tool.schema.parse({ to: 'alice@example.com', body: 'hi' })
      await sendMessage!.tool.handler(
        input,
        toolContext({ origin: 'trusted:user', toolCallId: 'call-9' }),
      )

      expect(transport.deliveries[0]?.effectId).toBe('call-9')
    })

    it('stamps trusted:system on a delivery from a trusted turn', async () => {
      const transport = new RecordingTransport()
      const [sendMessage] = createOutboundTools(transport)
      const input = sendMessage!.tool.schema.parse({ to: 'alice@example.com', body: 'hi' })
      await sendMessage!.tool.handler(
        input,
        toolContext({ origin: 'trusted:user', spaceId: 'spc-health' }),
      )

      expect(transport.deliveries[0]?.payload['origin']).toBe('trusted:system')
    })

    it('keeps the untrusted mark on a delivery from an untrusted turn', async () => {
      const transport = new RecordingTransport()
      const [, transferFunds] = createOutboundTools(transport)
      const input = transferFunds!.tool.schema.parse({ to: 'iban-1', amount: 5 })
      await transferFunds!.tool.handler(
        input,
        toolContext({ origin: 'untrusted:gmail', spaceId: 'spc-health' }),
      )

      expect(transport.deliveries[0]?.payload['origin']).toBe('untrusted:gmail')
    })

    it('returns a sensible ToolResult for transfer_funds', async () => {
      const transport = new RecordingTransport()
      const [, transferFunds] = createOutboundTools(transport)
      const input = transferFunds!.tool.schema.parse({ to: 'iban-1', amount: 25, currency: 'USD' })
      const result = await transferFunds!.tool.handler(
        input,
        toolContext({ origin: 'trusted:user', spaceId: 'spc-health' }),
      )

      expect(result.content).toBe('Transferred 25 USD to iban-1.')
    })
  })

  describe('ToolMeta', () => {
    it('titles and summarizes send_message, and normalizes allowlist params to lowercase', () => {
      const input = { to: 'Alice@Example.com', body: 'hello there' }
      expect(sendMessageMeta.title(input)).toContain('Alice@Example.com')
      expect(sendMessageMeta.summary(input)).toContain('hello there')
      expect(sendMessageMeta.editableKeys).toEqual(['body'])
      expect(sendMessageMeta.allowlistParams?.(input)).toEqual({ to: 'alice@example.com' })
    })

    it('gives transfer_funds no allowlistParams and no editable fields', () => {
      expect(transferFundsMeta.allowlistParams).toBeUndefined()
      expect(transferFundsMeta.editableKeys).toEqual([])
    })
  })

  describe('createMockOutboundTransport', () => {
    it('records a delivery as a Space event in the payload spaceId, with the given origin', async () => {
      const engine = await tempEngine()
      const transport = createMockOutboundTransport(engine)

      await transport.deliver({
        effectId: 'effect-1',
        tool: 'send_message',
        payload: {
          to: 'alice@example.com',
          body: 'hi',
          spaceId: 'spc-health',
          origin: 'trusted:system',
        },
      })

      const events = engine.readRecent('spc-health', 20)
      const delivered = events.find((event) => event.type === 'outbound.delivery')
      expect(delivered).toBeDefined()
      expect(delivered?.origin).toBe('trusted:system')
      expect(delivered?.payload?.['tool']).toBe('send_message')
      expect(delivered?.payload?.['effectId']).toBe('effect-1')
    })

    it('preserves an untrusted origin on the recorded delivery event', async () => {
      const engine = await tempEngine()
      const transport = createMockOutboundTransport(engine)

      await transport.deliver({
        effectId: 'effect-2',
        tool: 'transfer_funds',
        payload: { to: 'iban-1', amount: 5, spaceId: 'spc-health', origin: 'untrusted:gmail' },
      })

      const events = engine.readRecent('spc-health', 20)
      const delivered = events.find((event) => event.type === 'outbound.delivery')
      expect(delivered?.origin).toBe('untrusted:gmail')
    })

    it('dedupes by effectId: a second deliver() with the same effectId is a no-op', async () => {
      const engine = await tempEngine()
      const transport = createMockOutboundTransport(engine)
      const delivery = {
        effectId: 'effect-3',
        tool: 'send_message',
        payload: {
          to: 'alice@example.com',
          body: 'hi',
          spaceId: 'spc-health',
          origin: 'trusted:system',
        },
      }

      await transport.deliver(delivery)
      await transport.deliver(delivery)

      const events = engine.readRecent('spc-health', 20)
      const deliveries = events.filter((event) => event.type === 'outbound.delivery')
      expect(deliveries).toHaveLength(1)
    })

    it('throws when the payload has no spaceId', async () => {
      const engine = await tempEngine()
      const transport = createMockOutboundTransport(engine)
      await expect(
        transport.deliver({
          effectId: 'effect-4',
          tool: 'send_message',
          payload: { to: 'alice@example.com', body: 'hi', origin: 'trusted:system' },
        }),
      ).rejects.toThrow(/spaceId/)
    })

    it('dedupes against the persisted Space log across a fresh transport instance (crash-recovery simulation)', async () => {
      const engine = await tempEngine()
      const delivery = {
        effectId: 'effect-6',
        tool: 'send_message',
        payload: {
          to: 'alice@example.com',
          body: 'hi',
          spaceId: 'spc-health',
          origin: 'trusted:system',
        },
      }
      // First delivery, one transport instance — the ordinary case.
      await createMockOutboundTransport(engine).deliver(delivery)

      // A brand-new transport (empty in-memory `Set`, as after a daemon
      // restart) over the SAME, persisted `SpacesEngine`: the trust layer's
      // own recovery can re-invoke `deliver()` with the same effectId for a
      // delivery that already committed in a prior process.
      await createMockOutboundTransport(engine).deliver(delivery)

      const events = engine.readRecent('spc-health', 20)
      const deliveries = events.filter((event) => event.type === 'outbound.delivery')
      expect(deliveries).toHaveLength(1)
    })

    it('throws when the payload has no valid origin', async () => {
      const engine = await tempEngine()
      const transport = createMockOutboundTransport(engine)
      await expect(
        transport.deliver({
          effectId: 'effect-5',
          tool: 'send_message',
          payload: { to: 'alice@example.com', body: 'hi', spaceId: 'spc-health' },
        }),
      ).rejects.toThrow(/origin/)
    })
  })
})
