import { defineTool, type ToolDef } from './agent-runner.ts'
import { WorkerBriefingSchema, truncateGoalLabel } from './worker-briefing.ts'
import type { WorkerPool } from './worker.ts'

/**
 * `spawn_worker` (issue #17, plan v2 T5): the Agent's only entry point for
 * starting a Worker. Resolves the active Space from `ToolContext.spaceId` —
 * a Worker always delivers its report into a Space, so a turn with no
 * active Space cannot spawn one — hands the briefing straight to the
 * `WorkerPool`, and returns immediately without awaiting the run: the
 * Worker investigates and reports back asynchronously, so chat stays
 * responsive while it works.
 */
export function createSpawnWorkerTool(pool: WorkerPool): ToolDef<typeof WorkerBriefingSchema> {
  return defineTool({
    name: 'spawn_worker',
    description:
      'Spawn an ephemeral background Worker to investigate one goal and deliver a schema-validated ' +
      'report Surface into the current Space. The Worker runs asynchronously under a token/iteration ' +
      'budget and, for high-risk briefings, a separate adversarial review before delivery. Use for ' +
      'parallelizable, read-heavy investigate-and-report work — never for actions with implicit decisions.',
    schema: WorkerBriefingSchema,
    level: 'L0',
    egressDomains: [],
    handler(input, context) {
      const spaceId = context.spaceId
      if (!spaceId) throw new Error('spawn_worker requires an active Space')

      const goalLabel = truncateGoalLabel(input.goal)
      const { workerId } = pool.spawn({
        briefing: input,
        spaceId,
        goalLabel,
        ...(context.trigger === undefined ? {} : { trigger: context.trigger }),
      })

      return {
        content: `spawned worker ${workerId}, researching: ${goalLabel}`,
        details: { workerId },
      }
    },
  })
}
