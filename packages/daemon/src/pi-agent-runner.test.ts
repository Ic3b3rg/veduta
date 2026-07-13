import { z } from 'zod'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  defineTool,
  disabledContextPolicy,
  type ContextPolicy,
  type SessionEntry,
} from './agent-runner.ts'
import {
  applyOriginEntries,
  originEntryData,
  toPiAgentTool,
  transformPiContext,
  type OriginMarkerEntry,
  type PiContextTransformOptions,
  type PiToolParameters,
  type RawSessionEntry,
} from './pi-agent-runner.ts'
import { TurnTaintAccumulator, type Origin } from './taint.ts'

/**
 * `applyOriginEntries` and `originEntryData` are the pure halves of the
 * `VEDUTA_MESSAGE_ORIGIN` annotates-next codec (v3 Major F): they operate
 * on plain `SessionEntry`/marker literals, with no `@earendil-works/pi-agent-core`
 * involved, so the annotate/reconstruct logic is testable in isolation from
 * the real pi session tree.
 *
 * Gating (`gateToolsForOrigins` applied inside `PiAgentRunner.prompt`) is
 * covered indirectly here (codec only) and directly via `MockAgentRunner`
 * (mock-agent-runner.test.ts): constructing a real `PiAgentRunner` needs a
 * working `Agent`/`resolveModel` from pi-agent-core, which is impractical
 * to unit-test without a provider — the contract-level gating behavior is
 * identical between the two runners by construction (both call
 * `gateToolsForOrigins` with the same effective-origin computation).
 */

function marker(origin: Origin): OriginMarkerEntry {
  return { kind: 'origin-marker', origin }
}

function userMessage(id: string, content: string): SessionEntry {
  return {
    id,
    parentId: null,
    at: '2026-07-09T00:00:00.000Z',
    type: 'message',
    message: { role: 'user', content, at: '2026-07-09T00:00:00.000Z' },
  }
}

function assistantMessage(id: string, content: string): SessionEntry {
  return {
    id,
    parentId: null,
    at: '2026-07-09T00:00:01.000Z',
    type: 'message',
    message: { role: 'assistant', content, at: '2026-07-09T00:00:01.000Z' },
  }
}

function modelChange(id: string): SessionEntry {
  return {
    id,
    parentId: null,
    at: '2026-07-09T00:00:00.500Z',
    type: 'model-change',
    model: { provider: 'mock', modelId: 'm', tier: 'triage' },
  }
}

describe('originEntryData', () => {
  it('encodes an origin into the custom-entry payload shape', () => {
    expect(originEntryData('untrusted:gmail')).toEqual({ origin: 'untrusted:gmail' })
  })
})

describe('applyOriginEntries', () => {
  it('attaches a marker origin to the immediately following message and drops the marker', () => {
    const entries: RawSessionEntry[] = [marker('untrusted:gmail'), userMessage('m1', 'read it')]
    const result = applyOriginEntries(entries)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: 'message', message: { origin: 'untrusted:gmail' } })
  })

  it('leaves unmarked messages without an origin', () => {
    const entries: RawSessionEntry[] = [userMessage('m1', 'hello'), assistantMessage('m2', 'hi')]
    const result = applyOriginEntries(entries)
    expect(
      result.map((entry) => (entry.type === 'message' ? entry.message.origin : undefined)),
    ).toEqual([undefined, undefined])
  })

  it('round-trips a mixed sequence, annotating only the marked message', () => {
    const entries: RawSessionEntry[] = [
      userMessage('m1', 'hello'),
      assistantMessage('m2', 'hi'),
      marker('untrusted:gmail'),
      userMessage('m3', 'read the email'),
      assistantMessage('m4', 'Displayed the requested content.'),
    ]
    const result = applyOriginEntries(entries)
    expect(result).toHaveLength(4)
    expect(
      result.map((entry) => (entry.type === 'message' ? entry.message.origin : undefined)),
    ).toEqual([undefined, undefined, 'untrusted:gmail', undefined])
  })

  it('keeps the origin entry attached to its message when a branch fork lands at that message (branch-at-message)', () => {
    const full: RawSessionEntry[] = [
      userMessage('m1', 'hello'),
      marker('untrusted:gmail'),
      userMessage('m2', 'read the email'),
      assistantMessage('m3', 'reply'),
    ]
    // Simulate `branch({ fromEntryId: 'm2' })`: ancestors are kept up to
    // and including the fork point, so the marker (which precedes it
    // immediately) is preserved in the slice.
    const forkIndex = full.findIndex((entry) => 'id' in entry && entry.id === 'm2')
    const branched = full.slice(0, forkIndex + 1)
    const result = applyOriginEntries(branched)
    expect(result.at(-1)).toMatchObject({ id: 'm2', message: { origin: 'untrusted:gmail' } })
  })

  it('drops both the marker and its message together when a branch forks before the marker (branch-before-message)', () => {
    const full: RawSessionEntry[] = [
      userMessage('m1', 'hello'),
      marker('untrusted:gmail'),
      userMessage('m2', 'read the email'),
    ]
    // Simulate `branch({ fromEntryId: 'm1' })`: neither the marker nor the
    // message it annotates survive the fork, so there is nothing dangling.
    const forkIndex = full.findIndex((entry) => 'id' in entry && entry.id === 'm1')
    const branched = full.slice(0, forkIndex + 1)
    const result = applyOriginEntries(branched)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'm1' })
  })

  it('ignores a dangling marker with no following entry at all', () => {
    const entries: RawSessionEntry[] = [userMessage('m1', 'hello'), marker('untrusted:gmail')]
    const result = applyOriginEntries(entries)
    expect(result).toEqual([userMessage('m1', 'hello')])
  })

  it('ignores a dangling marker whose next entry is not a message', () => {
    const entries: RawSessionEntry[] = [marker('untrusted:gmail'), modelChange('mc1')]
    const result = applyOriginEntries(entries)
    expect(result).toEqual([modelChange('mc1')])
  })
})

/**
 * `transformPiContext` and `toPiAgentTool` are the pieces of D10/A3 that are
 * pure enough to unit-test without a live pi `Agent` (constructing one needs
 * a working provider — impractical to unit-test, see the module doc comment
 * above). Together they cover what `PiAgentRunner` wires internally: the
 * always-installed context-transform wrapper recomputing the context hash
 * on every model invocation, and a tool call folding its result's `origins`
 * into the live taint accumulator.
 */
function piMessage(content: string, timestamp: number): AgentMessage {
  return fromPartial<AgentMessage>({ role: 'user', content, timestamp })
}

function transformOptions(policy: ContextPolicy, input: string): PiContextTransformOptions {
  return {
    policy,
    sessionId: 'session-1',
    systemPrompt: undefined,
    input,
    fallbackModel: undefined,
  }
}

describe('transformPiContext', () => {
  it('reports a stable hash for an identical envelope', async () => {
    const hashes: string[] = []
    const messages = [piMessage('hello', 1)]

    await transformPiContext(messages, transformOptions(disabledContextPolicy, 'hello'), (hash) =>
      hashes.push(hash),
    )
    await transformPiContext(messages, transformOptions(disabledContextPolicy, 'hello'), (hash) =>
      hashes.push(hash),
    )

    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(hashes[0]).toBe(hashes[1])
  })

  it('recomputes a different hash once a tool result extends the message list mid-turn', async () => {
    const hashes: string[] = []
    const messages = [piMessage('hello', 1)]
    await transformPiContext(messages, transformOptions(disabledContextPolicy, 'hello'), (hash) =>
      hashes.push(hash),
    )

    const grown = [...messages, piMessage('a tool result', 2)]
    await transformPiContext(grown, transformOptions(disabledContextPolicy, 'hello'), (hash) =>
      hashes.push(hash),
    )

    expect(hashes[1]).not.toBe(hashes[0])
  })

  it('hashes the post-policy transformed messages, not the raw pi input, when a ContextPolicy is enabled', async () => {
    const droppingPolicy: ContextPolicy = {
      enabled: true,
      transform: (msgs) => msgs.filter((message) => message.role !== 'user'),
    }
    const hashes: string[] = []
    await transformPiContext(
      [piMessage('secret', 1)],
      transformOptions(droppingPolicy, 'secret'),
      (hash) => hashes.push(hash),
    )
    await transformPiContext([], transformOptions(disabledContextPolicy, 'secret'), (hash) =>
      hashes.push(hash),
    )

    // Both envelopes end up with an empty transformed message list plus the
    // same input: hashing what actually crossed the wrapper boundary (not
    // the raw pi messages) makes the two equal.
    expect(hashes[0]).toBe(hashes[1])
  })
})

describe('toPiAgentTool', () => {
  const parameters = fromPartial<PiToolParameters>({})

  it("folds a tool result's origins into the live taint accumulator and reports them for persistence", async () => {
    const taint = new TurnTaintAccumulator(['trusted:user'])
    const tool = defineTool({
      name: 'read_recent',
      description: 'read-only',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'an untrusted event', origins: ['untrusted:gmail'] }),
    })
    const recorded: [string, Origin[]][] = []

    const agentTool = toPiAgentTool(
      tool,
      parameters,
      (toolCallId, signal) => ({
        toolCallId,
        origin: 'trusted:user',
        origins: ['trusted:user'],
        taint,
        contextHash: 'irrelevant-for-this-test',
        ...(signal ? { signal } : {}),
      }),
      (toolCallId, origins) => recorded.push([toolCallId, origins]),
    )

    const result = await agentTool.execute('call-1', {})

    expect(taint.origins()).toEqual(['trusted:user', 'untrusted:gmail'])
    expect(recorded).toEqual([['call-1', ['untrusted:gmail']]])
    expect(result.content).toEqual([{ type: 'text', text: 'an untrusted event' }])
  })

  it('never records or accumulates when the tool result reports no origins', async () => {
    const taint = new TurnTaintAccumulator(['trusted:user'])
    const tool = defineTool({
      name: 'noop',
      description: 'no provenance',
      schema: z.object({}),
      level: 'L0',
      egressDomains: [],
      handler: () => ({ content: 'ok' }),
    })
    const recorded: unknown[] = []

    const agentTool = toPiAgentTool(
      tool,
      parameters,
      (toolCallId) => ({
        toolCallId,
        origin: 'trusted:user',
        origins: ['trusted:user'],
        taint,
        contextHash: 'irrelevant-for-this-test',
      }),
      (...args) => recorded.push(args),
    )

    await agentTool.execute('call-2', {})

    expect(recorded).toEqual([])
    expect(taint.origins()).toEqual(['trusted:user'])
  })
})
