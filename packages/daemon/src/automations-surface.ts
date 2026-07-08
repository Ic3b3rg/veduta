import { SurfaceSchema, type AtomNode, type Surface } from '@veduta/protocol'

/**
 * The per-Space "Automations" Surface (issue #11, ADR-0005): every job
 * and timer the Agent arms is visible here and switchable off by the
 * user. The tree shape is fixed — root Box -> [Title, list Box] — so
 * the scheduler refreshes it with a single tree operation replacing
 * the list node (tree patch values are single AtomNodes by protocol).
 */
export interface AutomationListItem {
  id: number
  description: string
  enabled: boolean
  scheduleText: string
}

export const AUTOMATIONS_LIST_NODE_ID = 'automations-list'

export function automationsSurfaceId(spaceSlug: string): string {
  return `srf-${spaceSlug}-automations`
}

export function automationStateKey(id: number): string {
  return `job-${id}`
}

export function automationIdFromStateKey(stateKey: string): number | undefined {
  const match = /^job-(\d+)$/.exec(stateKey)
  return match ? Number(match[1]) : undefined
}

export function automationsState(automations: AutomationListItem[]): Record<string, boolean> {
  return Object.fromEntries(
    automations.map((automation) => [automationStateKey(automation.id), automation.enabled]),
  )
}

export function automationsListNode(automations: AutomationListItem[]): AtomNode {
  const children: AtomNode[] =
    automations.length === 0
      ? [{ id: 'no-automations', type: 'Caption', props: { text: 'No automations yet.' } }]
      : automations.map((automation) => ({
          id: `automation-${automation.id}`,
          type: 'Automation',
          binding: automationStateKey(automation.id),
          props: { label: automation.description, schedule: automation.scheduleText },
          actions: [
            {
              name: 'toggle',
              path: 'fast',
              payload: {},
              stateKey: automationStateKey(automation.id),
            },
          ],
        }))
  return { id: AUTOMATIONS_LIST_NODE_ID, type: 'Box', children }
}

export function automationsSurface(
  space: { id: string; slug: string },
  automations: AutomationListItem[],
  freshness: { updatedAt: string; updatedBy: 'job' },
): Surface {
  return SurfaceSchema.parse({
    id: automationsSurfaceId(space.slug),
    spaceId: space.id,
    title: 'Automations',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Automations' } },
        automationsListNode(automations),
      ],
    },
    state: automationsState(automations),
    freshness,
  })
}
