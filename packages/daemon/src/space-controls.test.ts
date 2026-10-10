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
import { TrustLayer } from './trust-layer.ts'
import { registerSpaceArchiveTool } from './space-archive-tool.ts'

const roots: string[] = []
const trusts: TrustLayer[] = []
afterEach(() => {
  trusts.splice(0).forEach((trust) => trust.dispose())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})
function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-space-controls-'))
  roots.push(rootDir)
  const engine = new SpacesEngine({ rootDir })
  const space = engine.createSpace({ name: 'Health' })
  const trust = new TrustLayer({
    rootDir,
    approvalCardPort: {
      create: (approval) => ({ surfaceId: `srf-${approval.id}` }),
      readEditedFields: () => ({}),
      patchValidationError: () => {},
      archive: () => {},
    },
    onApprovalCard: () => {},
    appendOutcomeEvent: () => {},
  })
  trusts.push(trust)
  const archiveTool = registerSpaceArchiveTool(engine, trust)
  return { rootDir, engine, space, trust, archiveTool }
}
function context(text: string): ToolContext {
  return fromPartial<ToolContext>({
    origin: 'trusted:user',
    origins: ['trusted:user'],
    toolCallId: 'archive-call',
    contextHash: 'test-space-archival',
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

  it('archives only after approval without deleting facts and restores the same Space', async () => {
    const { engine, space, trust, archiveTool } = setup()
    engine.writeFact(space.id, 'I walk every morning')
    const request = 'Remove this Space'
    const archive = createSpaceControlTools(engine, space.id, archiveTool).find(
      (tool) => tool.name === 'archive_space',
    )!
    await archive.handler({ userRequest: request }, context(request))
    expect(engine.getSpace(space.id)?.archived).toBe(false)
    await trust.resolvePrepared(trust.listPending()[0]!.approval.id, 'approve')
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
    const { engine, space, archiveTool } = setup()
    engine.ensureSystemSpace({ name: 'System', slug: 'system' })
    const archive = createSpaceControlTools(engine, space.id, archiveTool).find(
      (tool) => tool.name === 'archive_space',
    )!
    await expect(async () =>
      archive.handler({ userRequest: 'archive' }, context('read my facts')),
    ).rejects.toThrow('current user request')
    expect(engine.getSpace(space.id)?.archived).toBe(false)
    expect(() => engine.archiveSpace(SYSTEM_SPACE_ID)).toThrow()
    expect(() => engine.restoreSpace(SYSTEM_SPACE_ID)).toThrow()
    const systemArchive = createSpaceControlTools(engine, SYSTEM_SPACE_ID, archiveTool)[0]!
    await expect(async () =>
      systemArchive.handler({ userRequest: 'archive' }, context('archive')),
    ).rejects.toThrow('active ordinary Space')
    const missingArchive = createSpaceControlTools(engine, 'missing', archiveTool)[0]!
    await expect(async () =>
      missingArchive.handler({ userRequest: 'archive' }, context('archive')),
    ).rejects.toThrow('active ordinary Space')
  })

  it('does not repeat an approved archival during recovery after a later restore', async () => {
    const { engine, rootDir, space, trust, archiveTool } = setup()
    const expectedRevision = engine.spaceLifecycleRevision(space.id)
    const archive = createSpaceControlTools(engine, space.id, archiveTool)[0]!
    await archive.handler({ userRequest: 'archive' }, context('archive'))
    const effectId = trust.listPending()[0]!.approval.id
    await trust.resolvePrepared(effectId, 'approve')
    engine.restoreSpace(space.id)
    const reopened = new SpacesEngine({ rootDir })
    reopened.archiveSpace(space.id, 'trusted:system', { effectId, expectedRevision })
    expect(reopened.getSpace(space.id)?.archived).toBe(false)
    expect(
      reopened.readRecent(space.id).filter((event) => event.text === 'Archived Space'),
    ).toHaveLength(1)
  })
})
