import { SYSTEM_SPACE_ID } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { SpacesEngine } from './spaces-engine.ts'
import type { TrustLayer, ToolMeta } from './trust-layer.ts'
import { SettingsRecoveryPendingError } from './settings-mutation.ts'
import { ToolRecoveryPendingError } from './tool-recovery.ts'

const ArchiveInputSchema = z
  .object({
    spaceId: z.string().min(1),
    spaceName: z.string().min(1),
    expectedRevision: z.string().min(1),
  })
  .strict()

/** Register once at boot so approvals remain executable after their Chat turn or a restart. */
export function registerSpaceArchiveTool(engine: SpacesEngine, trust: TrustLayer): ToolDef {
  const tool = defineTool({
    name: 'archive_space',
    description:
      'Archive the exact Space after explicit approval. Its content remains recoverable.',
    schema: ArchiveInputSchema,
    level: 'L2',
    egressDomains: [],
    handler(input, context) {
      if (!context.effectId || context.spaceId !== input.spaceId)
        throw new Error('Space archival requires its own approval')
      const current = engine.getSpace(input.spaceId)
      if (!current || current.id === SYSTEM_SPACE_ID || current.name !== input.spaceName)
        throw new Error('The reviewed Space is no longer available. Request a new approval.')
      let space
      try {
        space = engine.archiveSpace(input.spaceId, 'trusted:system', {
          effectId: context.effectId,
          expectedRevision: input.expectedRevision,
        })
      } catch (error) {
        if (error instanceof SettingsRecoveryPendingError) throw new ToolRecoveryPendingError(error)
        throw error
      }
      return {
        content: `Archived Space "${space.name}". Its content is preserved and can be restored in Settings.`,
        details: { space },
      }
    },
  })
  const meta: ToolMeta<z.infer<typeof ArchiveInputSchema>> = {
    title: (input) => `Archive Space “${input.spaceName}”`,
    summary: (input) =>
      `Remove Space “${input.spaceName}” from Home. Memory, Surfaces and Chat history are preserved. ` +
      'You can restore this Space in Connections → Spaces & memory. ' +
      'Approve to archive it; Reject to keep it active. Nothing is permanently deleted.',
  }
  trust.register(tool, meta)
  return trust.wrapTools([tool])[0]!
}
