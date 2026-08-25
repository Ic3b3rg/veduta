import {
  PendingDecisionResolveResultSchema,
  type PendingDecisionResolution,
  type PendingDecisionResolveResult,
} from '@veduta/protocol'
import { postJson } from './api-http.ts'

/** Resolves one daemon-owned Pending decision through its exact stable id. */
export async function resolvePendingDecision(
  decisionId: string,
  resolution: PendingDecisionResolution,
  token?: string,
): Promise<PendingDecisionResolveResult> {
  return PendingDecisionResolveResultSchema.parse(
    await postJson(
      `/api/pending-decisions/${encodeURIComponent(decisionId)}/resolve`,
      { resolution },
      token,
    ),
  )
}
