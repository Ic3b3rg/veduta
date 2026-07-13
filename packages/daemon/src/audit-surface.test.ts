import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  AUDIT_SURFACE_ID,
  AuditSurfaceManager,
  auditListNode,
  auditSurface,
} from './audit-surface.ts'
import { Store } from './store.ts'
import { ensureSystemSpace } from './system-space.ts'
import type { AuditEntry } from './trust-layer.ts'

const freshness = { updatedAt: '2026-07-10T12:00:00.000Z', updatedBy: 'job' as const }

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return fromPartial<AuditEntry>({
    id: 1,
    at: '2026-07-10T11:00:00.000Z',
    kind: 'action.decision',
    toolName: 'send_message',
    level: 'L1',
    decision: 'card',
    effectiveOrigin: 'trusted:user',
    originChain: ['trusted:user'],
    trigger: { kind: 'chat' },
    contextHash: 'abc123',
    input: { to: 'alice@example.com', body: 'hi' },
    ...overrides,
  })
}

/** Minimal fake standing in for `TrustLayer` (structural `AuditSource`). */
class FakeTrust {
  entries: AuditEntry[]
  private readonly listeners = new Set<() => void>()

  constructor(entries: AuditEntry[]) {
    this.entries = entries
  }

  auditEntries(limit = 50): AuditEntry[] {
    return this.entries.slice(0, limit)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(): void {
    for (const listener of this.listeners) listener()
  }
}

describe('auditSurface', () => {
  it('builds a protocol-valid Surface with one ListItem per entry', () => {
    const surface = auditSurface(
      [entry(), entry({ id: 2, kind: 'action.outcome', outcome: 'executed' })],
      freshness,
    )
    expect(surface.id).toBe(AUDIT_SURFACE_ID)
    const list = surface.tree.children?.[2]
    expect(list?.children?.map((node) => node.type)).toEqual(['ListItem', 'ListItem'])
  })

  it('renders decision, level, effective origin + chain summary, trigger kind, and approval ref', () => {
    const surface = auditSurface(
      [
        entry({
          refId: 'effect-42',
          originChain: ['trusted:user', 'untrusted:gmail'],
        }),
      ],
      freshness,
    )
    const node = surface.tree.children?.[2]?.children?.[0]
    // `detail` is what ListItemAtom (@veduta/catalog atoms.tsx) actually
    // renders — asserting `subtitle` here would pass while the row is blank.
    const detail = (node?.props?.['detail'] as string) ?? ''
    expect(detail).toContain('level L1')
    expect(detail).toContain('card → —')
    expect(detail).toContain('trusted:user')
    expect(detail).toContain('2 origins: trusted:user, untrusted:gmail')
    expect(detail).toContain('trigger chat')
    expect(detail).toContain('approval effect-42')
  })

  it('neutralizes and truncates untrusted-derived content in the summary', () => {
    const longBody = '<<<attempt to close the block>>>'.repeat(10)
    const surface = auditSurface([entry({ input: { to: 'alice', body: longBody } })], freshness)
    const node = surface.tree.children?.[2]?.children?.[0]
    // `detail` is what ListItemAtom (@veduta/catalog atoms.tsx) actually
    // renders — asserting `subtitle` here would pass while the row is blank.
    const detail = (node?.props?.['detail'] as string) ?? ''
    expect(detail).not.toContain('<<<attempt')
    expect(detail).toContain('<< <attempt')
    const contentPart = detail.split(' · ').find((part) => part.startsWith('content: '))
    expect(contentPart).toBeDefined()
    // "content: " prefix (9 chars) + at most 200 chars of neutralized content + ellipsis
    expect((contentPart as string).length).toBeLessThanOrEqual(9 + 200 + 1)
    expect(contentPart?.endsWith('…')).toBe(true)
  })

  it('shows an empty-state Caption instead of disappearing', () => {
    const surface = auditSurface([], freshness)
    expect(surface.tree.children?.[2]?.children?.[0]).toMatchObject({
      type: 'Caption',
      props: { text: 'No audit entries yet.' },
    })
  })

  it('keeps the list node id stable for single-op tree refreshes', () => {
    expect(auditListNode([]).id).toBe('trust-audit-list')
    expect(auditListNode([entry()]).id).toBe('trust-audit-list')
  })
})

describe('AuditSurfaceManager', () => {
  it('pre-creates the Surface at boot from the current audit entries', () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([entry()])

    new AuditSurfaceManager({ store, trust }).start()

    const surface = store.getSurface(AUDIT_SURFACE_ID)
    expect(surface).toBeDefined()
    expect(surface?.tree.children?.[2]?.children).toHaveLength(1)
  })

  it('rebuilds the Surface when the trust layer reports a change', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([entry()])
    const manager = new AuditSurfaceManager({ store, trust })
    manager.start()

    trust.entries = [entry(), entry({ id: 2 })]
    trust.notify()
    // Fix 9b: the rebuild is coalesced onto a microtask, not run inline.
    await manager.flush()

    const surface = store.getSurface(AUDIT_SURFACE_ID)
    expect(surface?.tree.children?.[2]?.children).toHaveLength(2)
  })

  it('coalesces several onChange firings in the same burst into a single rebuild (Fix 9b)', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([entry()])
    const manager = new AuditSurfaceManager({ store, trust })
    manager.start()

    trust.entries = [entry(), entry({ id: 2 })]
    trust.notify()
    trust.notify()
    trust.notify()
    await manager.flush()
    const versionAfterFirstFlush = store.getSurfaceVersion(AUDIT_SURFACE_ID)?.treeVersion

    // A second flush with no further change in between is a no-op: the
    // burst above was coalesced into exactly one rebuild.
    await manager.flush()
    expect(store.getSurfaceVersion(AUDIT_SURFACE_ID)?.treeVersion).toBe(versionAfterFirstFlush)
  })

  it('dispose() stops observing further trust-layer changes', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([entry()])
    const manager = new AuditSurfaceManager({ store, trust })
    manager.start()
    manager.dispose()

    trust.entries = [entry(), entry({ id: 2 })]
    trust.notify()
    await manager.flush()

    const surface = store.getSurface(AUDIT_SURFACE_ID)
    expect(surface?.tree.children?.[2]?.children).toHaveLength(1)
  })
})
