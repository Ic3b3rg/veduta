import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
import { fromPartial } from '@total-typescript/shoehorn'
import { describe, expect, it } from 'vitest'
import type { WorkerReport } from './worker-briefing.ts'
import {
  WORKER_CANCEL_STATE_KEY,
  WORKER_CONTENT_INDEX,
  WORKER_FOOTER_INDEX,
  WORKER_SETTLED_STATE_KEY,
  WORKER_STATUS_INDEX,
  activeWorkerSurface,
  workerReportContentNode,
  workerSurfaceId,
  workerTerminalFooterNode,
} from './worker-surface.ts'

const updatedAt = '2026-07-15T06:00:00.000Z'

function collectNodes(node: AtomNode): AtomNode[] {
  return [node, ...(node.children ?? []).flatMap(collectNodes)]
}

function findNode(tree: AtomNode, id: string): AtomNode | undefined {
  return collectNodes(tree).find((node) => node.id === id)
}

function report(overrides: Partial<WorkerReport> = {}): WorkerReport {
  return fromPartial<WorkerReport>({
    version: 'worker-report/v1',
    title: 'Ketogenic diet: an overview',
    summary: 'A short summary of the findings.',
    sections: [
      { heading: 'Benefits', body: 'Some benefits.' },
      { heading: 'Risks', body: 'Some risks.' },
    ],
    ...overrides,
  })
}

describe('workerSurfaceId', () => {
  it('is deterministic from the workerId', () => {
    expect(workerSurfaceId('wkr-1')).toBe('srf-worker-wkr-1')
  })
})

describe('activeWorkerSurface', () => {
  it('parses as a valid Surface', () => {
    const surface = activeWorkerSurface({
      workerId: 'wkr-1',
      spaceId: 'spc-1',
      goalLabel: 'Research the ketogenic diet',
      etaMinutes: 5,
      updatedAt,
    })
    expect(() => SurfaceSchema.parse(surface)).not.toThrow()
    expect(surface.id).toBe('srf-worker-wkr-1')
    expect(surface.freshness).toEqual({ updatedAt, updatedBy: 'job' })
  })

  it('declares the cancel Button as a fast action on the cancelled state key', () => {
    const surface = activeWorkerSurface({
      workerId: 'wkr-1',
      spaceId: 'spc-1',
      goalLabel: 'Research the ketogenic diet',
      etaMinutes: 5,
      updatedAt,
    })
    const cancelButton = findNode(surface.tree, 'worker-cancel')
    expect(cancelButton?.type).toBe('Button')
    expect(cancelButton?.actions).toEqual([
      { name: 'cancel', path: 'fast', stateKey: WORKER_CANCEL_STATE_KEY, payload: {} },
    ])
  })

  it('sets initial state with cancelled: false and settled: false', () => {
    const surface = activeWorkerSurface({
      workerId: 'wkr-1',
      spaceId: 'spc-1',
      goalLabel: 'Research the ketogenic diet',
      etaMinutes: 5,
      updatedAt,
    })
    expect(surface.state).toEqual({
      [WORKER_CANCEL_STATE_KEY]: false,
      [WORKER_SETTLED_STATE_KEY]: false,
    })
  })

  it('uses the stable "Worker: <goal>" title', () => {
    const surface = activeWorkerSurface({
      workerId: 'wkr-1',
      spaceId: 'spc-1',
      goalLabel: 'Research the ketogenic diet',
      etaMinutes: 5,
      updatedAt,
    })
    expect(surface.title).toBe('Worker: Research the ketogenic diet')
    expect(findNode(surface.tree, 'title')?.props).toMatchObject({
      text: 'Worker: Research the ketogenic diet',
    })
  })

  it('child index invariants hold for patchTree-by-index', () => {
    const surface = activeWorkerSurface({
      workerId: 'wkr-1',
      spaceId: 'spc-1',
      goalLabel: 'Research the ketogenic diet',
      etaMinutes: 5,
      updatedAt,
    })
    const children = surface.tree.children ?? []
    expect(children[WORKER_STATUS_INDEX]?.id).toBe('worker-status')
    expect(children[WORKER_CONTENT_INDEX]?.id).toBe('worker-content')
    expect(children[WORKER_FOOTER_INDEX]?.id).toBe('worker-footer')
  })
})

// `terminalWorkerSurface` was production-dead (worker.ts patches the active
// Surface in place, node by node, via `patchTree` — it never builds a whole
// terminal Surface from scratch) and has been removed. These tests exercise
// the node builders it used to assemble directly instead.
describe('workerReportContentNode', () => {
  it('renders the report title, summary, and one section node per section', () => {
    const node = workerReportContentNode(report())
    expect(findNode(node, 'report-title')?.props).toMatchObject({
      text: 'Ketogenic diet: an overview',
    })
    expect(findNode(node, 'report-summary')?.props).toMatchObject({
      text: 'A short summary of the findings.',
    })
    expect(findNode(node, 'section-0')?.props).toMatchObject({
      text: '**Benefits**\n\nSome benefits.',
    })
    expect(findNode(node, 'section-1')?.props).toMatchObject({
      text: '**Risks**\n\nSome risks.',
    })
    expect(findNode(node, 'section-2')).toBeUndefined()
  })
})

describe('workerTerminalFooterNode', () => {
  it('shows a "Review passed" badge when reviewStatus is passed', () => {
    const node = workerTerminalFooterNode({
      partial: false,
      cancelled: false,
      reviewStatus: 'passed',
    })
    const badge = findNode(node, 'badge-review-passed')
    expect(badge?.type).toBe('Badge')
    expect(badge?.props).toMatchObject({ text: 'Review passed', tone: 'success' })
  })

  it('shows a partial badge when partial: true', () => {
    const node = workerTerminalFooterNode({ partial: true, cancelled: false })
    const badge = findNode(node, 'badge-partial')
    expect(badge?.type).toBe('Badge')
    expect(badge?.props).toMatchObject({ text: 'Partial (budget reached)', tone: 'warning' })
  })

  it('shows a cancelled badge when cancelled: true', () => {
    const node = workerTerminalFooterNode({ partial: false, cancelled: true })
    const badge = findNode(node, 'badge-cancelled')
    expect(badge?.type).toBe('Badge')
    expect(badge?.props).toMatchObject({ text: 'Cancelled', tone: 'warning' })
  })

  it('shows the caveat when caveat is present', () => {
    const node = workerTerminalFooterNode({
      partial: false,
      cancelled: false,
      caveat: 'One claim was unsupported and was removed.',
    })
    const badge = findNode(node, 'badge-caveat')
    expect(badge?.type).toBe('Badge')
    expect(badge?.props).toMatchObject({
      text: 'One claim was unsupported and was removed.',
      tone: 'warning',
    })
  })

  it('renders no badges when nothing applies', () => {
    const node = workerTerminalFooterNode({ partial: false, cancelled: false })
    expect(node.children).toEqual([])
  })
})
