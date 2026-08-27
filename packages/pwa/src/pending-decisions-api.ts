import {
  PendingDecisionListSchema,
  PendingDecisionResolveResultSchema,
  type PendingDecisionList,
  type PendingDecisionResolution,
  type PendingDecisionResolveResult,
} from '@veduta/protocol'
import { getJson, postJson } from './api-http.ts'

/** Reads the daemon's authoritative Pending-decision snapshot for startup and reconnect recovery. */
export async function fetchPendingDecisions(token?: string): Promise<PendingDecisionList> {
  return PendingDecisionListSchema.parse(await getJson('/api/pending-decisions', token))
}

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
