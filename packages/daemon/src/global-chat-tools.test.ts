import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import {
  SurfaceSchema,
  type ChatResultTarget,
  type PendingDecision,
  type Space,
} from '@veduta/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolContext, ToolDef } from './agent-runner.ts'
import { createFocusedSurfaceTools } from './focused-surface-tools.ts'
import { createGlobalChatTools, type GlobalChatTurnHooks } from './global-chat-tools.ts'
import { createMemoryTools } from './memory-tools.ts'
import { createMockOutboundTransport, createOutboundTools } from './outbound-tools.ts'
import { Store } from './store.ts'
import { SurfaceReadError } from './surface-engine.ts'
import { ensureSystemSpace, SYSTEM_SPACE_ID } from './system-space.ts'
import { TurnTaintAccumulator, gateToolsForOrigins } from './taint.ts'
import { templateTools, TemplateEngine } from './template-engine.ts'
import type { ApprovalCardPort, PendingApproval } from './trust-contracts.ts'
import { isTrustWrapped, TrustLayer } from './trust-layer.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-global-chat-tools-'))
  roots.push(rootDir)
  return rootDir
}

function context(toolCallId = 'call-enter'): ToolContext {
  return fromPartial<ToolContext>({
    toolCallId,
    origin: 'trusted:user',
    origins: ['trusted:user'],
    taint: new TurnTaintAccumulator(['trusted:user']),
    contextHash: 'global-chat-tools-test',
    initiatingTurn: { clientId: 'pwa-test', turnId: 'turn-test' },
  })
}

interface Harness {
  store: Store
  health: Space
  tools: ToolDef[]
  entered: Space[]
  targets: ChatResultTarget[]
  decisions: PendingDecision[]
}

function harness(): Harness {
  const store = new Store({ rootDir: tempRoot() })
  ensureSystemSpace(store.spacesEngine)
  const health = store.getSpace('spc-health')!
  const templateEngine = new TemplateEngine({ store })
  const entered: Space[] = []
  const targets: ChatResultTarget[] = []
  const decisions: PendingDecision[] = []
  const hooks: GlobalChatTurnHooks = {
    onSpaceEntered: (space) => entered.push(space),
    onResultTarget: (target) => targets.push(target),
    onPendingDecision: (decision) => decisions.push(decision),
  }
  const focusedToolsFor = (spaceId: string) => [
    ...createFocusedSurfaceTools({ store, templateEngine, spaceId }),
    ...createMemoryTools(store.spacesEngine, { activeSpaceId: spaceId }),
    ...templateTools(templateEngine, { activeSpaceId: spaceId }),
  ]
  return {
    store,
    health,
    entered,
    targets,
    decisions,
    tools: createGlobalChatTools({ store, focusedToolsFor, hooks }),
  }
}

function toolNamed(tools: ToolDef[], name: string): ToolDef {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) throw new Error(`missing test tool: ${name}`)
  return tool
}

describe('createGlobalChatTools', () => {
  it('requires entry, reports origins, and correlates delegated writes', async () => {
    const h = harness()
    h.store.spacesEngine.appendEvent(h.health.id, {
      type: 'reader.summary',
      text: 'Untrusted mail summary',
      origin: 'untrusted:gmail',
    })
    const enterSpace = toolNamed(h.tools, 'enter_space')
    const writeFact = toolNamed(h.tools, 'write_fact')
    const appendEvent = toolNamed(h.tools, 'append_event')

    await expect(
      writeFact.handler(
        writeFact.schema.parse({ spaceId: h.health.slug, fact: 'Weight goal set.' }),
        context('call-blind'),
      ),
    ).rejects.toThrow(/enter_space first/)

    const enteredResult = await enterSpace.handler(
      enterSpace.schema.parse({ spaceId: h.health.slug }),
      context(),
    )
    expect(enteredResult).toMatchObject({
      content: expect.stringContaining(`Health (${h.health.slug})`),
      origins: expect.arrayContaining(['untrusted:gmail']),
    })

    await writeFact.handler(
      writeFact.schema.parse({ spaceId: h.health.id, fact: 'Training is on Tuesday.' }),
      context('call-write'),
    )
    await appendEvent.handler(
      appendEvent.schema.parse({
        spaceId: h.health.id,
        text: 'A correlated plan note',
        payload: { correlationId: 'forged-correlation' },
      }),
      context('call-append'),
    )

    expect(h.entered).toEqual([expect.objectContaining({ id: h.health.id })])
    expect(h.targets).toContainEqual({
      spaceId: h.health.id,
      spaceSlug: h.health.slug,
      spaceName: h.health.name,
    })
    expect(
      h.store
        .eventLog(h.health.id)
        .filter((event) => event.type === 'turn.tool')
        .map((event) => event.payload),
    ).toEqual([
      expect.objectContaining({
        correlationId: 'turn-test',
        toolCallId: 'call-enter',
        toolName: 'enter_space',
        outcome: 'completed',
        mutation: false,
      }),
      expect.objectContaining({
        correlationId: 'turn-test',
        toolCallId: 'call-write',
        toolName: 'write_fact',
        outcome: 'completed',
        mutation: true,
      }),
      expect.objectContaining({
        correlationId: 'turn-test',
        toolCallId: 'call-append',
        toolName: 'append_event',
        outcome: 'completed',
        mutation: true,
      }),
    ])
    expect(
      h.store.eventLog(h.health.id).find((event) => event.text === 'A correlated plan note'),
    ).toMatchObject({ payload: { correlationId: 'turn-test' } })
  })

  it('rejects System, unknown, and archived Spaces without entering or writing them', () => {
    const h = harness()
    const archived = h.store.spacesEngine.createSpace({ name: 'Archived Target' })
    h.store.archiveSpace(archived.id)
    const beforeSystem = h.store.eventLog(SYSTEM_SPACE_ID).length
    const beforeArchived = h.store.eventLog(archived.id).length
    const enterSpace = toolNamed(h.tools, 'enter_space')

    for (const [target, error] of [
      [SYSTEM_SPACE_ID, /System Space/],
      ['does-not-exist', /unknown Space/],
      [archived.slug, /archived Space/],
    ] as const) {
      expect(() =>
        enterSpace.handler(enterSpace.schema.parse({ spaceId: target }), context()),
      ).toThrow(error)
    }
    expect(h.entered).toEqual([])
    expect(h.store.eventLog(SYSTEM_SPACE_ID)).toHaveLength(beforeSystem)
    expect(h.store.eventLog(archived.id)).toHaveLength(beforeArchived)
  })

  it('creates only a pending Space proposal until the user confirms it', async () => {
    const h = harness()
    const beforeSpaceIds = h.store.spacesEngine.listAllSpaces().map((space) => space.id)
    const proposeSpace = toolNamed(h.tools, 'propose_space')
    const result = await proposeSpace.handler(
      proposeSpace.schema.parse({ name: 'Travel', reason: 'Plan future trips.' }),
      context(),
    )
    const proposal = h.store.spacesEngine.listSpaceProposals().at(-1)!

    expect(result.content).toContain('for user confirmation')
    expect(proposal).toMatchObject({ name: 'Travel', status: 'pending' })
    expect(h.decisions).toEqual([
      expect.objectContaining({
        id: `space-proposal:${proposal.id}`,
        kind: 'space-proposal',
        summary: 'Create Space “Travel”',
        allowedResolutions: ['accept', 'reject'],
        state: 'pending',
      }),
    ])
    expect(h.store.spacesEngine.listAllSpaces().map((space) => space.id)).toEqual(beforeSpaceIds)
    expect(h.store.getSurface(proposal.spaceId)).toBeUndefined()

    const created = h.store.spacesEngine.confirmSpaceProposal(proposal.id, 'trusted:user')
    expect(created.id).toBe(proposal.spaceId)
    expect(h.store.listAuthorableSurfaces(created.id).surfaces).toEqual([])
  })

  it('returns a Surface deep-link target for a scoped creation', async () => {
    const h = harness()
    const enterSpace = toolNamed(h.tools, 'enter_space')
    const createSurface = toolNamed(h.tools, 'create_surface')
    await enterSpace.handler(enterSpace.schema.parse({ spaceId: h.health.slug }), context())
    await createSurface.handler(
      createSurface.schema.parse({
        spaceId: h.health.slug,
        id: 'srf-global-weight',
        title: 'Weight tracker',
        tree: { id: 'root', type: 'Stat', binding: 'weight', props: { label: 'Weight' } },
        state: { weight: 72 },
      }),
      context('call-create'),
    )

    expect(h.targets.at(-1)).toEqual({
      spaceId: h.health.id,
      spaceSlug: h.health.slug,
      spaceName: h.health.name,
      surfaceId: 'srf-global-weight',
      surfaceTitle: 'Weight tracker',
    })
    expect(
      h.store
        .eventLog(h.health.id)
        .find(
          (event) =>
            event.type === 'surface.create' && event.payload?.['surfaceId'] === 'srf-global-weight',
        ),
    ).toMatchObject({ payload: { correlationId: 'turn-test' } })
  })

  it('uses the same non-disclosing authorability guard for scoped Surface actions', async () => {
    const h = harness()
    const otherSpace = h.store.spacesEngine.createSpace({ name: 'Other Pin Scope' })
    for (const surface of [
      SurfaceSchema.parse({
        id: 'srf-other-pin-scope',
        spaceId: otherSpace.id,
        title: 'Other pin scope',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        pinned: false,
        pinnable: true,
        freshness: {
          updatedAt: '2026-08-25T10:00:00.000Z',
          updatedBy: 'agent',
        },
      }),
      SurfaceSchema.parse({
        id: 'srf-daemon-owned-pin',
        spaceId: h.health.id,
        title: 'Daemon-owned pin scope',
        tree: { id: 'root', type: 'Box', children: [] },
        state: {},
        pinned: false,
        pinnable: true,
        freshness: {
          updatedAt: '2026-08-25T10:00:00.000Z',
          updatedBy: 'agent',
        },
      }),
    ]) {
      h.store.createSurface(
        surface,
        'agent',
        surface.id === 'srf-daemon-owned-pin' ? { daemonOwned: true } : {},
      )
    }
    const enterSpace = toolNamed(h.tools, 'enter_space')
    const pinSurface = toolNamed(h.tools, 'pin_surface')
    await enterSpace.handler(enterSpace.schema.parse({ spaceId: h.health.id }), context())

    for (const surfaceId of ['srf-other-pin-scope', 'srf-daemon-owned-pin']) {
      await expect(
        pinSurface.handler(
          pinSurface.schema.parse({ spaceId: h.health.id, surfaceId, pinned: true }),
          context(`call-pin-${surfaceId}`),
        ),
      ).rejects.toThrow(SurfaceReadError)
      expect(h.store.getSurface(surfaceId)?.pinned).not.toBe(true)
    }
  })

  it('preserves the trust wrapper on scoped outbound adapters', () => {
    const rootDir = tempRoot()
    const store = new Store({ rootDir })
    const health = store.spacesEngine.createSpace({ name: 'Health' })
    const trust = new TrustLayer({
      rootDir,
      approvalCardPort: fromPartial<ApprovalCardPort>({
        create(approval: PendingApproval) {
          return { surfaceId: `srf-approval-${approval.id}` }
        },
      }),
      onApprovalCard: () => {},
      appendOutcomeEvent: () => {},
    })
    try {
      const registrations = createOutboundTools(createMockOutboundTransport(store.spacesEngine))
      for (const { tool, meta } of registrations) trust.register(tool, meta)
      const wrapped = trust.wrapTools(registrations.map(({ tool }) => tool))
      const tools = createGlobalChatTools({ store, focusedToolsFor: () => wrapped })

      expect(
        toolNamed(tools, 'send_message').schema.safeParse({ spaceId: health.id }).success,
      ).toBe(false)
      expect(
        gateToolsForOrigins(tools, ['untrusted:gmail'], isTrustWrapped).map((tool) => tool.name),
      ).toEqual(expect.arrayContaining(['send_message', 'transfer_funds']))
    } finally {
      trust.dispose()
    }
  })
})
