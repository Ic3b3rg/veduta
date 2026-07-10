import { describe, expect, it } from 'vitest'
import type { SessionEntry } from './agent-runner.ts'
import {
  applyOriginEntries,
  originEntryData,
  type OriginMarkerEntry,
  type RawSessionEntry,
} from './pi-agent-runner.ts'
import type { Origin } from './taint.ts'

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
