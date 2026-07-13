import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import {
  ALLOWLIST_SURFACE_ID,
  AllowlistSurfaceManager,
  allowlistListNode,
  allowlistSurface,
  revokeStateKey,
  ruleIdFromRevokeStateKey,
  type AllowlistSource,
} from './allowlist-surface.ts'
import { Store } from './store.ts'
import { ensureSystemSpace } from './system-space.ts'
import type { AllowlistRule } from './trust-layer.ts'

const freshness = { updatedAt: '2026-07-10T12:00:00.000Z', updatedBy: 'job' as const }

function rule(overrides: Partial<AllowlistRule> = {}): AllowlistRule {
  return fromPartial<AllowlistRule>({
    id: 1,
    toolName: 'send_message',
    params: { to: 'alice@example.com' },
    paramsJson: '{"to":"alice@example.com"}',
    createdAt: '2026-07-09T10:00:00.000Z',
    createdFromApprovalId: 'effect-1',
    ...overrides,
  })
}

/** Minimal fake standing in for `TrustLayer` (structural `AllowlistSource`). */
class FakeTrust implements AllowlistSource {
  rules: AllowlistRule[]
  readonly revokedIds: number[] = []
  private readonly listeners = new Set<() => void>()

  constructor(rules: AllowlistRule[]) {
    this.rules = rules
  }

  listAllowlistRules(): AllowlistRule[] {
    return this.rules
  }

  revokeAllowlistRule(id: number): void {
    this.revokedIds.push(id)
    this.rules = this.rules.map((entry) =>
      entry.id === id ? { ...entry, revokedAt: '2026-07-10T13:00:00.000Z' } : entry,
    )
    for (const listener of this.listeners) listener()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

describe('allowlistSurface', () => {
  it('builds a protocol-valid Surface with one Row per active rule', () => {
    const surface = allowlistSurface(
      [rule(), rule({ id: 2, toolName: 'transfer_funds' })],
      freshness,
    )
    expect(surface.id).toBe(ALLOWLIST_SURFACE_ID)
    const list = surface.tree.children?.[2]
    expect(list?.children?.map((node) => node.type)).toEqual(['Row', 'Row'])
  })

  it('renders the tool name and params via the ListItem label/detail props', () => {
    // `label`/`detail` are the props ListItemAtom (@veduta/catalog atoms.tsx)
    // actually reads — `title`/`subtitle` render nothing (Fix 1 regression).
    const surface = allowlistSurface([rule()], freshness)
    const summary = surface.tree.children?.[2]?.children?.[0]?.children?.[0]
    expect(summary?.type).toBe('ListItem')
    expect(summary?.props?.['label']).toBe('send_message')
    expect(summary?.props?.['detail']).toBe(
      'to=alice@example.com — allowed since 2026-07-09T10:00:00.000Z',
    )
  })

  it('declares Revoke as a fast action on the rule state key', () => {
    const surface = allowlistSurface([rule()], freshness)
    const row = surface.tree.children?.[2]?.children?.[0]
    const revokeButton = row?.children?.[1]
    expect(revokeButton?.type).toBe('Button')
    expect(revokeButton?.actions?.[0]).toMatchObject({
      name: 'revoke',
      path: 'fast',
      stateKey: 'revoke.1',
      payload: { value: true },
    })
  })

  it('shows an empty-state Caption instead of disappearing', () => {
    const surface = allowlistSurface([], freshness)
    expect(surface.tree.children?.[2]?.children?.[0]).toMatchObject({
      type: 'Caption',
      props: { text: 'No allowlisted actions yet.' },
    })
  })

  it('round-trips ids through the revoke state key', () => {
    expect(revokeStateKey(7)).toBe('revoke.7')
    expect(ruleIdFromRevokeStateKey('revoke.7')).toBe(7)
    expect(ruleIdFromRevokeStateKey('job-7')).toBeUndefined()
  })

  it('keeps the list node id stable for single-op tree refreshes', () => {
    expect(allowlistListNode([]).id).toBe('trust-allowlist-list')
    expect(allowlistListNode([rule()]).id).toBe('trust-allowlist-list')
  })
})

describe('AllowlistSurfaceManager', () => {
  it('pre-creates the Surface at boot from the current rules', () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([rule()])

    new AllowlistSurfaceManager({ store, trust }).start()

    const surface = store.getSurface(ALLOWLIST_SURFACE_ID)
    expect(surface).toBeDefined()
    const list = surface?.tree.children?.[2]
    expect(list?.children).toHaveLength(1)
  })

  it('rebuilds the Surface when the trust layer reports a change', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([rule()])
    const manager = new AllowlistSurfaceManager({ store, trust })
    manager.start()

    trust.rules = [rule(), rule({ id: 2, toolName: 'transfer_funds' })]
    trust.revokeAllowlistRule(999) // any change notifies listeners
    // Fix 9b: the rebuild is coalesced onto a microtask, not run inline.
    await manager.flush()

    const surface = store.getSurface(ALLOWLIST_SURFACE_ID)
    const list = surface?.tree.children?.[2]
    expect(list?.children).toHaveLength(2)
  })

  it('coalesces several onChange firings in the same burst into a single rebuild (Fix 9b)', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([rule()])
    const manager = new AllowlistSurfaceManager({ store, trust })
    manager.start()
    let notifications = 0
    const unsubscribe = trust.onChange(() => {
      notifications += 1
    })

    trust.rules = [rule(), rule({ id: 2, toolName: 'transfer_funds' })]
    trust.revokeAllowlistRule(999)
    trust.revokeAllowlistRule(998)
    trust.revokeAllowlistRule(997)
    expect(notifications).toBe(3) // the trust layer itself still fires every time...
    await manager.flush()
    const versionAfterFirstFlush = store.getSurfaceVersion(ALLOWLIST_SURFACE_ID)?.treeVersion

    // ...but a second flush with no further change in between is a no-op:
    // the burst above was coalesced into exactly one rebuild.
    await manager.flush()
    expect(store.getSurfaceVersion(ALLOWLIST_SURFACE_ID)?.treeVersion).toBe(versionAfterFirstFlush)
    unsubscribe()
  })

  it('revoking via the fast action calls trust.revokeAllowlistRule and refreshes the Surface', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([rule({ id: 5 })])
    const manager = new AllowlistSurfaceManager({ store, trust })
    manager.start()

    store.invokeSurfaceAction(ALLOWLIST_SURFACE_ID, {
      nodeId: 'allowlist-rule-5-revoke',
      name: 'revoke',
      payload: { value: true },
    })
    // The revoke call is deferred to a microtask so the click's own fast-path
    // patch broadcasts before the rebuild it triggers; the rebuild itself is
    // further coalesced onto its own microtask (Fix 9b), so both hops must
    // settle before asserting.
    await Promise.resolve()
    await Promise.resolve()
    await manager.flush()

    expect(trust.revokedIds).toEqual([5])
    const surface = store.getSurface(ALLOWLIST_SURFACE_ID)
    expect(surface?.tree.children?.[2]?.children?.[0]).toMatchObject({
      type: 'Caption',
      props: { text: 'No allowlisted actions yet.' },
    })
  })

  it('dispose() stops observing further changes and fast mutations', async () => {
    const store = new Store()
    ensureSystemSpace(store.spacesEngine)
    const trust = new FakeTrust([rule({ id: 9 })])
    const manager = new AllowlistSurfaceManager({ store, trust })
    manager.start()
    manager.dispose()

    store.invokeSurfaceAction(ALLOWLIST_SURFACE_ID, {
      nodeId: 'allowlist-rule-9-revoke',
      name: 'revoke',
      payload: { value: true },
    })
    await Promise.resolve()
    await Promise.resolve()
    await manager.flush()

    expect(trust.revokedIds).toEqual([])
  })
})
