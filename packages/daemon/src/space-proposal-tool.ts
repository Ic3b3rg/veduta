import { z } from 'zod'
import { formatPendingDecisionId, type PendingDecision } from '@veduta/protocol'
import { defineTool, type ToolDef } from './agent-runner.ts'
import { SpacePendingDecisionAdapter } from './space-pending-decision.ts'
import type { SpacesEngine } from './spaces-engine.ts'

const ProposeSpaceSchema = z.object({
  name: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(1000),
})

/** One proposal capability shared by global and focused Chat; it grants no Space access. */
export function createSpaceProposalTool(
  spaces: SpacesEngine,
  onPendingDecision?: (decision: PendingDecision) => void,
): ToolDef {
  return defineTool({
    name: 'propose_space',
    description:
      'Create a pending one-tap Space proposal when no active Space fits. This never creates the Space or any Surface; only the user can accept it.',
    schema: ProposeSpaceSchema,
    level: 'L0',
    egressDomains: [],
    handler(input) {
      const proposal = spaces.proposeSpace(input)
      const decision = new SpacePendingDecisionAdapter(spaces).get(
        formatPendingDecisionId('space-proposal', proposal.id),
      )
      if (!decision) throw new Error(`pending Space proposal is unavailable: ${proposal.id}`)
      onPendingDecision?.(decision)
      return {
        content: `proposed Space "${proposal.name}" for user confirmation (${proposal.id})`,
        details: { proposal, decision },
      }
    },
  })
}
