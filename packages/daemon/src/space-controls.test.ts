import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import { SYSTEM_SPACE_ID } from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext } from './agent-runner.ts'
import { createSpaceControlTools } from './space-controls.ts'
import { SpacesEngine } from './spaces-engine.ts'
import { TurnTaintAccumulator } from './taint.ts'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-space-controls-'))
  roots.push(rootDir)
  const engine = new SpacesEngine({ rootDir })
  const space = engine.createSpace({ name: 'Health' })
  return { rootDir, engine, space }
}
function context(text: string): ToolContext {
  return fromPartial<ToolContext>({
    origin: 'trusted:user',
    taint: new TurnTaintAccumulator(['trusted:user']),
    trigger: { kind: 'chat' },
    initiatingTurn: { clientId: 'test', turnId: 'turn-1' },
    currentUserRequest: { text, origin: 'trusted:user' },
  })
}

describe('shared Space controls', () => {
  it('persists presentation for only the requested Space and records a single event', () => {
    const { rootDir, engine, space } = setup()
    const other = engine.createSpace({ name: 'Work' })
    engine.setSpacePresentation(space.id, 'two-columns')
    engine.setSpacePresentation(space.id, 'two-columns')
    const reopened = new SpacesEngine({ rootDir })
    expect(reopened.getSpace(space.id)?.presentation).toBe('two-columns')
    expect(reopened.getSpace(other.id)?.presentation ?? 'auto').toBe('auto')
    expect(
      reopened.readRecent(space.id, 20).filter((event) => event.type === 'space.presentation'),
    ).toHaveLength(1)
  })

  it('archives through the focused tool without deleting facts and restores the same Space', async () => {
    const { engine, space } = setup()
    engine.writeFact(space.id, 'I walk every morning')
    const request = 'Remove this Space'
    const archive = createSpaceControlTools(engine, space.id).find(
      (tool) => tool.name === 'archive_space',
    )!
    await archive.handler({ userRequest: request }, context(request))
    expect(engine.listSpaces()).toEqual([])
    engine.restoreSpace(space.id)
    expect(engine.readFacts(space.id).active[0]?.text).toBe('I walk every morning')
    expect(engine.getSpace(space.id)?.archived).toBe(false)
  })

  it('allows the same harmless presentation preference in System without changing its lifecycle', () => {
    const { engine } = setup()
    engine.ensureSystemSpace({ name: 'System', slug: 'system' })
    engine.setSpacePresentation(SYSTEM_SPACE_ID, 'two-columns')
    expect(engine.getSpace(SYSTEM_SPACE_ID)).toMatchObject({
      archived: false,
      presentation: 'two-columns',
    })
  })

  it('refuses invented user authorization and protects the System lifecycle', async () => {
    const { engine, space } = setup()
    engine.ensureSystemSpace({ name: 'System', slug: 'system' })
    const archive = createSpaceControlTools(engine, space.id).find(
      (tool) => tool.name === 'archive_space',
    )!
    await expect(async () =>
      archive.handler({ userRequest: 'archive' }, context('read my facts')),
    ).rejects.toThrow('current user request')
    expect(engine.getSpace(space.id)?.archived).toBe(false)
    expect(() => engine.archiveSpace(SYSTEM_SPACE_ID)).toThrow()
    expect(() => engine.restoreSpace(SYSTEM_SPACE_ID)).toThrow()
  })
})
