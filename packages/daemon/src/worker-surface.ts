import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'
import type { WorkerReport } from './worker-briefing.ts'

/**
 * The per-Worker report Surface (issue #17, plan v2 T2): a Worker's active
 * run and its eventual delivery are the SAME Surface, patched in place —
 * `patchTree` cannot change a Surface's title (`store.ts`), so the tree is a
 * FIXED 4-child shape from spawn onward: [Title, status Caption, content Box,
 * footer Box]. Only children at `WORKER_STATUS_INDEX`/`WORKER_CONTENT_INDEX`/
 * `WORKER_FOOTER_INDEX` are ever replaced (tree-patch values are single
 * AtomNodes by protocol, mirrors `heartbeat-surface.ts`). Declarative Atoms
 * only, validated via `SurfaceSchema.parse` before the caller persists them.
 */

export const WORKER_CANCEL_STATE_KEY = 'cancelled'
/**
 * Set to `true` once a Worker's report has been delivered (or its boot-time
 * recovery has run) — `recoverAtBoot` (worker.ts) checks this key so a
 * restart can never re-patch an already-delivered Surface to "Interrupted",
 * clobbering the real report and appending a duplicate `worker.delivered`.
 */
export const WORKER_SETTLED_STATE_KEY = 'settled'

export const WORKER_STATUS_INDEX = 1
export const WORKER_CONTENT_INDEX = 2
export const WORKER_FOOTER_INDEX = 3

export function workerSurfaceId(workerId: string): string {
  return `srf-worker-${workerId}`
}

/** Stable across active -> terminal: computed once from the goal, never from run state. */
function workerTitle(goalLabel: string): string {
  return `Worker: ${goalLabel}`
}

export function workerStatusNode(text: string): AtomNode {
  return { id: 'worker-status', type: 'Caption', props: { text } }
}

export function workerActiveContentNode(): AtomNode {
  return {
    id: 'worker-content',
    type: 'Box',
    children: [{ id: 'worker-progress', type: 'Progress', props: { label: 'Researching…' } }],
  }
}

export function workerReportContentNode(report: WorkerReport): AtomNode {
  return {
    id: 'worker-content',
    type: 'Box',
    children: [
      { id: 'report-title', type: 'Label', props: { text: report.title } },
      { id: 'report-summary', type: 'Markdown', props: { text: report.summary } },
      ...report.sections.map((section, index): AtomNode => ({
        id: `section-${index}`,
        type: 'Markdown',
        props: { text: `**${section.heading}**\n\n${section.body}` },
      })),
    ],
  }
}

export function workerActiveFooterNode(): AtomNode {
  return {
    id: 'worker-footer',
    type: 'Box',
    children: [
      {
        id: 'worker-cancel',
        type: 'Button',
        props: { label: 'Cancel' },
        actions: [{ name: 'cancel', path: 'fast', stateKey: WORKER_CANCEL_STATE_KEY, payload: {} }],
      },
    ],
  }
}

export function workerTerminalFooterNode(opts: {
  partial: boolean
  cancelled: boolean
  caveat?: string
  reviewStatus?: 'passed' | 'skipped'
}): AtomNode {
  const children: AtomNode[] = []
  if (opts.cancelled) {
    children.push({
      id: 'badge-cancelled',
      type: 'Badge',
      props: { text: 'Cancelled', tone: 'warning' },
    })
  }
  if (opts.partial) {
    children.push({
      id: 'badge-partial',
      type: 'Badge',
      props: { text: 'Partial (budget reached)', tone: 'warning' },
    })
  }
  if (opts.caveat !== undefined) {
    children.push({
      id: 'badge-caveat',
      type: 'Badge',
      props: { text: opts.caveat, tone: 'warning' },
    })
  }
  if (opts.reviewStatus === 'passed') {
    children.push({
      id: 'badge-review-passed',
      type: 'Badge',
      props: { text: 'Review passed', tone: 'success' },
    })
  }
  // Fixed slot (like heartbeat's badge slot): an empty Box when nothing
  // applies keeps the tree shape identical regardless of terminal outcome.
  return { id: 'worker-footer', type: 'Box', children }
}

export function activeWorkerSurface(args: {
  workerId: string
  spaceId: string
  goalLabel: string
  etaMinutes: number
  updatedAt: string
}): Surface {
  const title = workerTitle(args.goalLabel)
  return SurfaceSchema.parse({
    id: workerSurfaceId(args.workerId),
    spaceId: args.spaceId,
    title,
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: title } },
        workerStatusNode(`researching ${args.goalLabel}, ~${args.etaMinutes} min`),
        workerActiveContentNode(),
        workerActiveFooterNode(),
      ],
    },
    state: { [WORKER_CANCEL_STATE_KEY]: false, [WORKER_SETTLED_STATE_KEY]: false },
    freshness: { updatedAt: args.updatedAt, updatedBy: 'job' },
  })
}
