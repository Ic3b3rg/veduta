import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import type { Store } from './store.ts'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { neutralizeDelimiters, type Origin } from './taint.ts'
import type { AuditEntry } from './trust-layer.ts'

/**
 * The trust admin "Audit log" Surface (issue #14, D8): the last ~50 audit
 * rows, newest-first (`TrustLayer.auditEntries` already orders that way),
 * read-only — no actions, unlike the allowlist Surface. Lives in the
 * (persisted, `ensureSystemSpace`) System Space. Tree shape is fixed —
 * root Box -> [Title, Caption, list Box] — so refreshes replace only the
 * list node, mirroring `allowlist-surface.ts`/`automations-surface.ts`.
 */
export const AUDIT_SURFACE_ID = 'srf-trust-audit'
export const AUDIT_LIST_NODE_ID = 'trust-audit-list'
const MAX_ENTRIES = 50
/** Untrusted-derived audit content (`input_json`) is only ever rendered neutralized and truncated. */
const CONTENT_SUMMARY_LIMIT = 200

function summarizeChain(originChain: Origin[] | undefined): string {
  if (!originChain || originChain.length === 0) return 'n/a'
  const [only] = originChain
  if (originChain.length === 1 && only !== undefined) return only
  return `${originChain.length} origins: ${originChain.join(', ')}`
}

/** Audit `input_json`/`detail` may embed untrusted-derived content: neutralized + truncated, never raw. */
function contentSummary(entry: AuditEntry): string {
  const raw = entry.input !== undefined ? JSON.stringify(entry.input) : (entry.detail ?? '')
  const neutralized = neutralizeDelimiters(raw)
  return neutralized.length > CONTENT_SUMMARY_LIMIT
    ? `${neutralized.slice(0, CONTENT_SUMMARY_LIMIT)}…`
    : neutralized
}

function auditEntryNode(entry: AuditEntry): AtomNode {
  const decisionOutcome = `${entry.decision ?? '—'} → ${entry.outcome ?? '—'}`
  const summary = contentSummary(entry)
  const subtitleParts = [
    `level ${entry.level ?? 'n/a'}`,
    decisionOutcome,
    `origin ${entry.effectiveOrigin ?? 'n/a'} (chain: ${summarizeChain(entry.originChain)})`,
    `trigger ${entry.trigger?.kind ?? 'n/a'}`,
    summary ? `content: ${summary}` : undefined,
    entry.refId !== undefined ? `approval ${entry.refId}` : undefined,
  ].filter((part): part is string => Boolean(part))
  return {
    id: `audit-entry-${entry.id}`,
    type: 'ListItem',
    // `label`/`detail` are the props ListItemAtom (@veduta/catalog atoms.tsx)
    // actually reads — `title`/`subtitle` render nothing.
    props: {
      label: `${entry.at} · ${entry.toolName ?? entry.kind} · ${entry.kind}`,
      detail: subtitleParts.join(' · '),
    },
  }
}

export function auditListNode(entries: AuditEntry[]): AtomNode {
  const children: AtomNode[] =
    entries.length === 0
      ? [{ id: 'no-audit-entries', type: 'Caption', props: { text: 'No audit entries yet.' } }]
      : entries.map(auditEntryNode)
  return { id: AUDIT_LIST_NODE_ID, type: 'Box', children }
}

export function auditSurface(
  entries: AuditEntry[],
  freshness: { updatedAt: string; updatedBy: 'job' },
): Surface {
  return SurfaceSchema.parse({
    id: AUDIT_SURFACE_ID,
    spaceId: SYSTEM_SPACE_ID,
    title: 'Audit log',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Audit log' } },
        {
          id: 'subtitle',
          type: 'Caption',
          props: { text: `Most recent ${MAX_ENTRIES} trust decisions, newest first.` },
        },
        auditListNode(entries),
      ],
    },
    state: {},
    freshness,
  })
}

/**
 * The slice of `TrustLayer` this manager depends on (structural): a real
 * `TrustLayer` instance satisfies it as-is, and tests can supply a fake
 * without standing up a full trust layer.
 */
export interface AuditSource {
  auditEntries(limit?: number): AuditEntry[]
  onChange(listener: () => void): () => void
}

export interface AuditSurfaceManagerOptions {
  store: Store
  trust: AuditSource
  now?: () => Date
}

/**
 * Projects the trust layer's audit log onto `srf-trust-audit`, following
 * the scheduler's Surface-manager pattern: pre-create at boot, rebuild on
 * every trust-layer change. Read-only — no fast-mutation observer.
 */
export class AuditSurfaceManager {
  private readonly store: Store
  private readonly trust: AuditSource
  private readonly now: () => Date
  private disposeChange: (() => void) | undefined
  private dirty = false
  private coalesced: Promise<void> | undefined

  constructor(options: AuditSurfaceManagerOptions) {
    this.store = options.store
    this.trust = options.trust
    this.now = options.now ?? (() => new Date())
  }

  /** Pre-create the Surface (if missing) and start observing changes. */
  start(): void {
    this.ensureSurface()
    this.disposeChange = this.trust.onChange(() => this.scheduleRebuild())
  }

  dispose(): void {
    this.disposeChange?.()
    this.disposeChange = undefined
  }

  /** Test hook: resolves once any rebuild coalesced by the current burst has run. */
  flush(): Promise<void> {
    return this.coalesced ?? Promise.resolve()
  }

  private ensureSurface(): void {
    if (!this.store.getSurface(AUDIT_SURFACE_ID)) this.refreshSurface()
  }

  /**
   * `trust.onChange` can fire 2-4x per user action and each firing would
   * otherwise synchronously rebuild this Surface from scratch. Coalesce
   * every firing within the same microtask burst into a single rebuild
   * (Fix 9b): a `dirty` flag plus one shared, self-clearing microtask.
   */
  private scheduleRebuild(): void {
    this.dirty = true
    if (this.coalesced) return
    this.coalesced = Promise.resolve().then(() => {
      this.coalesced = undefined
      if (!this.dirty) return
      this.dirty = false
      this.refreshSurface()
    })
  }

  private refreshSurface(): void {
    const entries = this.trust.auditEntries(MAX_ENTRIES)
    const freshness = { updatedAt: this.now().toISOString(), updatedBy: 'job' as const }
    const existing = this.store.getSurface(AUDIT_SURFACE_ID)

    if (!existing) {
      // Daemon-owned: the trust admin audit log must not be rewritable by
      // the Agent (ADR-0007's structural-defense contract).
      this.store.createSurface(auditSurface(entries, freshness), 'job', { daemonOwned: true })
      return
    }

    const version = this.store.getSurfaceVersion(AUDIT_SURFACE_ID)
    if (!version) return
    this.store.patchTree(
      AUDIT_SURFACE_ID,
      [{ target: 'tree', op: 'replace', path: '/children/2', value: auditListNode(entries) }],
      { expectedTreeVersion: version.treeVersion, updatedBy: 'job' },
    )
  }
}
