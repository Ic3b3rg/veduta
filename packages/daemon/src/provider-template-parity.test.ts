import { SurfaceSchema } from '@veduta/protocol'
import { describe, expect, it } from 'vitest'
import {
  DESTINATION_SPACE_ID,
  DIRECT_SURFACE_ID,
  REUSED_SURFACE_ID,
  SOURCE_SPACE_ID,
  TEMPLATE_JUSTIFICATION,
  TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
  runTemplateParityPair,
  type TemplateParityOutcome,
  type TemplateParityToolResult,
} from './provider-template-parity-fixture.ts'

const EXPECTED_DEFINITIONS = [
  'list_surfaces',
  'read_surface',
  'create_surface',
  'patch_state',
  'patch_tree',
  'archive_surface',
  'list_templates',
  'create_surface_from_template',
  'pin_surface',
]

const EXPECTED_TOOL_CHAIN = [
  'list_templates',
  'create_surface_from_template',
  'pin_surface',
  'create_surface',
  'create_surface',
]

describe('AgentRunner Template parity across Model connection methods (issue #76)', () => {
  it('reuses, pins, and gates Templates with equivalent persisted outcomes', async () => {
    const { byok, subscription } = await runTemplateParityPair()

    expect(subscription.outcome).toEqual(byok.outcome)

    const outcome = subscription.outcome
    expect(outcome.offeredDefinitions.map((definition) => definition.name)).toEqual(
      EXPECTED_DEFINITIONS,
    )
    expect(
      outcome.offeredDefinitions
        .filter((definition) =>
          ['list_templates', 'create_surface_from_template', 'pin_surface'].includes(
            definition.name,
          ),
        )
        .map((definition) => definition.name),
    ).toEqual(['list_templates', 'create_surface_from_template', 'pin_surface'])

    const directCreateDefinition = requireDefinition(outcome, 'create_surface')
    const directCreateSchema = recordValue(directCreateDefinition.inputSchema, 'create schema')
    const directCreateProperties = recordValue(
      directCreateSchema['properties'],
      'create schema properties',
    )
    expect(Object.keys(directCreateProperties).sort()).toEqual(
      ['id', 'title', 'tree', 'state', 'relativeTime', 'intent', 'justification'].sort(),
    )

    expect(outcome.toolResults.map((result) => result.toolName)).toEqual(EXPECTED_TOOL_CHAIN)
    expect(outcome.handlerExecution).toEqual({
      total: 5,
      distinctCallIds: 5,
      maxCallsPerId: 1,
      allContextHashesValid: true,
      byTool: {
        list_templates: 1,
        create_surface_from_template: 1,
        pin_surface: 1,
        create_surface: 2,
      },
    })
    for (const run of [byok, subscription]) {
      expect(run.handlerCallIds).toEqual(run.acceptedCallIds)
      expect(new Set(run.acceptedCallIds).size).toBe(run.acceptedCallIds.length)
    }
    expect(subscription.acceptedCallIds).toEqual(['call-1', 'call-2', 'call-3', 'call-4', 'call-5'])
    expect(outcome.directSurfaceExistsAfterCalls).toEqual([false, true])

    expect(SurfaceSchema.parse(outcome.reusedSurface)).toEqual(outcome.reusedSurface)
    expect(outcome.reusedSurface).toMatchObject({
      id: REUSED_SURFACE_ID,
      spaceId: DESTINATION_SPACE_ID,
      pinned: true,
      state: { progress: 60, finished: false },
    })
    expect(outcome.reusedSurface.tree).toEqual(outcome.sourceTemplate.tree)
    expect(outcome.reusedProvenance).toEqual({
      templateId: outcome.sourceTemplate.id,
      templateSpaceId: SOURCE_SPACE_ID,
      contentOrigin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
    })

    expect(outcome.destinationTemplates).toHaveLength(1)
    const pinnedTemplate = outcome.destinationTemplates[0]
    if (!pinnedTemplate) throw new Error('expected pin_surface to persist one Template')
    expect(pinnedTemplate.tree).toEqual(outcome.sourceTemplate.tree)
    expect(pinnedTemplate.stateKeys).toEqual(['finished', 'progress'])
    expect(pinnedTemplate).toMatchObject({
      provenance: {
        sourceSurfaceId: REUSED_SURFACE_ID,
        sourceSpaceId: DESTINATION_SPACE_ID,
        savedBy: 'pin',
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
      },
    })

    expect(SurfaceSchema.parse(outcome.directSurface)).toEqual(outcome.directSurface)
    expect(outcome.directSurface).toMatchObject({
      id: DIRECT_SURFACE_ID,
      spaceId: DESTINATION_SPACE_ID,
      pinned: false,
      state: { progress: 0, finished: false },
    })
    expect(outcome.directProvenance).toEqual({
      contentOrigin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
    })

    const listed = requireToolResult(outcome, 0, 'list_templates')
    expect(listed.content).toContain(outcome.sourceTemplate.id)
    expect(listed.content).toContain('<<<UNTRUSTED data from template-import>>>')
    expect(listed.origins).toEqual([TEMPLATE_PARITY_UNTRUSTED_ORIGIN])

    const reused = requireToolResult(outcome, 1, 'create_surface_from_template')
    expect(reused.origins).toEqual([TEMPLATE_PARITY_UNTRUSTED_ORIGIN])

    const pinned = requireToolResult(outcome, 2, 'pin_surface')
    expect(pinned.content).toContain(pinnedTemplate.id)
    expect(pinned.origins).toEqual([TEMPLATE_PARITY_UNTRUSTED_ORIGIN])

    const refused = requireToolResult(outcome, 3, 'create_surface')
    expect(refused.content).toContain(pinnedTemplate.id)
    expect(refused.content).toContain('create_surface_from_template')
    expect(refused.content).toContain('justification')

    const justified = requireToolResult(outcome, 4, 'create_surface')
    expect(justified.content).toContain(DIRECT_SURFACE_ID)

    expect(outcome.eventLog).toEqual([
      {
        type: 'surface.create',
        text: 'Created Surface "Weekly reading tracker"',
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
        payload: { surfaceId: REUSED_SURFACE_ID },
      },
      {
        type: 'template.reused',
        text: `Reused Template "Reading progress tracker" from Space "${SOURCE_SPACE_ID}"`,
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
        payload: { templateId: outcome.sourceTemplate.id, sourceSpaceId: SOURCE_SPACE_ID },
      },
      {
        type: 'surface.pin',
        text: 'Pinned Surface "Weekly reading tracker"',
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
        payload: { surfaceId: REUSED_SURFACE_ID, pinned: true },
      },
      {
        type: 'template.saved',
        text: 'Saved Template "Weekly reading tracker" from Surface "Weekly reading tracker"',
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
        payload: { templateId: pinnedTemplate.id, surfaceId: REUSED_SURFACE_ID },
      },
      {
        type: 'surface.create',
        text: 'Created Surface "Weekly reading tracker"',
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
        payload: { surfaceId: DIRECT_SURFACE_ID },
      },
      {
        type: 'template.regenerated',
        text: `Regenerated a Surface instead of reusing Template "${pinnedTemplate.id}": ${TEMPLATE_JUSTIFICATION}`,
        origin: TEMPLATE_PARITY_UNTRUSTED_ORIGIN,
        payload: {
          templateId: pinnedTemplate.id,
          surfaceId: DIRECT_SURFACE_ID,
          justification: TEMPLATE_JUSTIFICATION,
        },
      },
    ])

    expect(outcome.taintBeforeCalls.map((call) => call.toolName)).toEqual(EXPECTED_TOOL_CHAIN)
    expect(outcome.taintBeforeCalls[0]?.origins).not.toContain(TEMPLATE_PARITY_UNTRUSTED_ORIGIN)
    for (const call of outcome.taintBeforeCalls.slice(1)) {
      expect(call.origins).toContain(TEMPLATE_PARITY_UNTRUSTED_ORIGIN)
    }

    expect(subscription.transport.requestMethods).toEqual(['thread/start', 'turn/start'])
    expect(subscription.transport.responseIds).toEqual([0, 1, 2, 3, 4])
    expect(subscription.transport.toolResultTexts).toEqual(byok.toolResultTexts)
  })
})

function requireDefinition(
  outcome: TemplateParityOutcome,
  name: string,
): TemplateParityOutcome['offeredDefinitions'][number] {
  const definition = outcome.offeredDefinitions.find((candidate) => candidate.name === name)
  if (!definition) throw new Error(`missing provider definition ${name}`)
  return definition
}

function requireToolResult(
  outcome: TemplateParityOutcome,
  index: number,
  toolName: string,
): TemplateParityToolResult {
  const result = outcome.toolResults[index]
  if (!result || result.toolName !== toolName) {
    throw new Error(`expected tool result ${index} to belong to ${toolName}`)
  }
  return result
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}
