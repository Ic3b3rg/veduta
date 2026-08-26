import { describe, expect, it } from 'vitest'
import type { AtomNode } from '@veduta/protocol'
import { SYSTEM_SPACE_ID } from './system-space.ts'
import { untrustedOrigin } from './taint.ts'
import {
  UPDATE_APPLY_STATE_KEY,
  UPDATE_CHECK_STATE_KEY,
  UPDATE_LAST_SUCCESSFUL_CHECK_STATE_KEY,
  UPDATE_SURFACE_ID,
  updateSurface,
  updateSurfaceContentOrigin,
  type UpdateSurfaceView,
} from './update-surface.ts'

const FRESHNESS = { updatedAt: '2026-08-05T00:00:00.000Z', updatedBy: 'job' as const }

function idleView(): UpdateSurfaceView {
  return { currentVersion: '1.0.0', status: 'idle' }
}

function findNode(node: AtomNode, id: string): AtomNode | undefined {
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, id)
    if (found) return found
  }
  return undefined
}

describe('updateSurface', () => {
  it('builds a schema-valid Surface in the System Space', () => {
    const surface = updateSurface(idleView(), FRESHNESS)
    expect(surface.id).toBe(UPDATE_SURFACE_ID)
    expect(surface.spaceId).toBe(SYSTEM_SPACE_ID)
    expect(surface.title).toBe('Updates')
    expect(surface.state).toEqual({
      [UPDATE_APPLY_STATE_KEY]: false,
      [UPDATE_CHECK_STATE_KEY]: false,
      [UPDATE_LAST_SUCCESSFUL_CHECK_STATE_KEY]: 'Not yet',
    })
  })

  it('always declares the Check now button, with its stateKey', () => {
    const surface = updateSurface(idleView(), FRESHNESS)
    const checkButton = findNode(surface.tree, 'update-check-button')
    expect(checkButton?.actions?.[0]?.stateKey).toBe(UPDATE_CHECK_STATE_KEY)
  })

  it('omits the Apply update button when status is idle', () => {
    const surface = updateSurface(idleView(), FRESHNESS)
    expect(findNode(surface.tree, 'update-apply-button')).toBeUndefined()
  })

  it('renders the Apply update button only when status is update-available', () => {
    const view: UpdateSurfaceView = {
      currentVersion: '1.0.0',
      status: 'update-available',
      available: { version: '1.1.0', notes: 'Bug fixes', migratesData: false },
    }
    const surface = updateSurface(view, FRESHNESS)
    const applyButton = findNode(surface.tree, 'update-apply-button')
    expect(applyButton?.actions?.[0]?.stateKey).toBe(UPDATE_APPLY_STATE_KEY)
  })

  it('shows the "migrates your data" caption only when the offer migrates data', () => {
    const migrating: UpdateSurfaceView = {
      currentVersion: '1.0.0',
      status: 'update-available',
      available: { version: '1.1.0', notes: 'Schema bump', migratesData: true },
    }
    const notMigrating: UpdateSurfaceView = {
      currentVersion: '1.0.0',
      status: 'update-available',
      available: { version: '1.1.0', notes: 'Code only', migratesData: false },
    }
    const migratingSurface = updateSurface(migrating, FRESHNESS)
    const notMigratingSurface = updateSurface(notMigrating, FRESHNESS)
    const caption = findNode(migratingSurface.tree, 'update-migrates-caption')
    expect(caption?.props?.['text']).toBe('Migrates your data — a backup is taken automatically')
    expect(findNode(notMigratingSurface.tree, 'update-migrates-caption')).toBeUndefined()
  })

  it('renders an empty available slot and no outcome badge when idle', () => {
    const surface = updateSurface(idleView(), FRESHNESS)
    const availableSlot = findNode(surface.tree, 'update-available-slot')
    expect(availableSlot?.children).toEqual([])
    expect(findNode(surface.tree, 'update-outcome-badge')).toBeUndefined()
  })

  it('keeps the last successful check timestamp in visible persisted state', () => {
    const checkedAt = '2026-08-05T06:30:00.000Z'
    const surface = updateSurface({ ...idleView(), lastSuccessfulCheckAt: checkedAt }, FRESHNESS)

    expect(surface.state[UPDATE_LAST_SUCCESSFUL_CHECK_STATE_KEY]).toBe(checkedAt)
    expect(findNode(surface.tree, 'update-last-successful-check')?.binding).toBe(
      UPDATE_LAST_SUCCESSFUL_CHECK_STATE_KEY,
    )
  })

  it('shows a success-tone outcome Badge once applied, and a danger tone once rolled back or refused', () => {
    const applied = updateSurface(
      { currentVersion: '1.1.0', status: 'applied', outcomeDetail: 'Updated to 1.1.0' },
      FRESHNESS,
    )
    const rolledBack = updateSurface(
      { currentVersion: '1.0.0', status: 'rolled-back', outcomeDetail: 'health check failed' },
      FRESHNESS,
    )
    const refused = updateSurface(
      { currentVersion: '1.0.0', status: 'refused', outcomeDetail: 'bad signature' },
      FRESHNESS,
    )
    expect(findNode(applied.tree, 'update-outcome-badge')?.props?.['tone']).toBe('success')
    expect(findNode(rolledBack.tree, 'update-outcome-badge')?.props?.['tone']).toBe('danger')
    expect(findNode(refused.tree, 'update-outcome-badge')?.props?.['tone']).toBe('danger')
  })

  it('shows a failed check without hiding an available update or a terminal apply outcome', () => {
    const updateAvailable = updateSurface(
      {
        currentVersion: '1.0.0',
        status: 'update-available',
        available: { version: '1.1.0', notes: 'Bug fixes', migratesData: false },
        checkError: 'signature verification failed',
      },
      FRESHNESS,
    )
    const applied = updateSurface(
      {
        currentVersion: '1.1.0',
        status: 'applied',
        outcomeDetail: 'Updated to 1.1.0',
        checkError: 'feed unavailable',
      },
      FRESHNESS,
    )

    expect(findNode(updateAvailable.tree, 'update-available-stat')?.props?.['value']).toBe('1.1.0')
    expect(findNode(updateAvailable.tree, 'update-apply-button')).toBeDefined()
    expect(findNode(updateAvailable.tree, 'update-check-error-badge')?.props).toMatchObject({
      text: 'Update check failed: signature verification failed',
      tone: 'danger',
    })
    expect(findNode(applied.tree, 'update-outcome-badge')?.props?.['text']).toBe('Updated to 1.1.0')
    expect(findNode(applied.tree, 'update-check-error-badge')?.props).toMatchObject({
      text: 'Update check failed: feed unavailable',
      tone: 'danger',
    })
  })
})

describe('updateSurfaceContentOrigin', () => {
  it('is untrusted:update-feed whenever an offer is shown', () => {
    const origin = updateSurfaceContentOrigin({
      version: '1.1.0',
      notes: 'from the feed',
      migratesData: false,
    })
    expect(origin).toBe(untrustedOrigin('update-feed'))
  })

  it('is trusted:system with no offer to show', () => {
    expect(updateSurfaceContentOrigin(undefined)).toBe('trusted:system')
  })
})
