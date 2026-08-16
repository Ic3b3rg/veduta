import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SpacePendingDecisionAdapter } from './space-pending-decision.ts'
import { SpacesEngine } from './spaces-engine.ts'

const roots: string[] = []
const fixedNow = () => new Date('2026-08-16T08:00:00.000Z')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('SpacePendingDecisionAdapter', () => {
  it('lists and resolves the exact durable Space proposal without owning creation logic', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-space-decision-'))
    roots.push(rootDir)
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const proposal = engine.proposeSpace({ name: 'Home', reason: 'Household routines.' })
    const adapter = new SpacePendingDecisionAdapter(engine)
    const id = `space-proposal:${proposal.id}`

    expect(adapter.get(id)).toEqual({
      id,
      kind: 'space-proposal',
      summary: 'Create Space “Home”',
      scope: { type: 'global' },
      allowedResolutions: ['accept', 'reject'],
      state: 'pending',
      createdAt: '2026-08-16T08:00:00.000Z',
    })

    await expect(adapter.resolve(id, 'accept', 'trusted:user')).resolves.toMatchObject({
      id,
      state: 'terminal',
      outcome: 'accepted',
      resolvedBy: 'trusted:user',
    })
    expect(engine.getSpace('spc-home')).toBeDefined()

    const reopened = new SpacePendingDecisionAdapter(new SpacesEngine({ rootDir, now: fixedNow }))
    expect(reopened.get(id)).toMatchObject({ state: 'terminal', outcome: 'accepted' })
  })

  it('returns a rejected proposal as terminal truth with no created Space', async () => {
    const rootDir = mkdtempSync(join(tmpdir(), 'veduta-space-decision-'))
    roots.push(rootDir)
    const engine = new SpacesEngine({ rootDir, now: fixedNow })
    const proposal = engine.proposeSpace({ name: 'Travel', reason: 'Maybe later.' })
    const adapter = new SpacePendingDecisionAdapter(engine)

    const decision = await adapter.resolve(
      `space-proposal:${proposal.id}`,
      'reject',
      'trusted:user',
    )

    expect(decision).toMatchObject({ state: 'terminal', outcome: 'rejected' })
    expect(engine.getSpace('spc-travel')).toBeUndefined()
  })
})
