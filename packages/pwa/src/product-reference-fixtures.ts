import { catalogShowcaseSurface } from '@veduta/catalog'
import {
  OnboardingStatusSchema,
  SurfaceSchema,
  SYSTEM_SPACE_ID,
  type ChatTimelineEntry,
  type PendingDecision,
} from '@veduta/protocol'
import type { SpaceWithSurfaces } from './api.ts'

import { referenceAt } from './product-reference-data.ts'
export { referenceAt, referenceNow, referenceModels } from './product-reference-data.ts'

export const referenceStates = [
  'long',
  'empty',
  'loading',
  'stale',
  'updated',
  'error',
  'offline',
  'queued',
  'reduced-motion',
] as const
export type ReferenceState = (typeof referenceStates)[number]

export const referenceSurface = SurfaceSchema.parse({
  id: 'srf-reference-plan',
  spaceId: 'spc-reference-home',
  title: 'Home plan — kitchen repairs, groceries and the weekend with family',
  tree: {
    id: 'plan',
    type: 'Box',
    children: [
      { id: 'plan-title', type: 'Title', props: { text: 'Make room for the weekend' } },
      {
        id: 'plan-detail',
        type: 'Markdown',
        props: {
          text: '**Friday:** confirm the kitchen repair appointment.\n\n- Buy groceries for six people.\n- Ask about allergies before choosing the menu.\n- Leave Saturday afternoon free for family.',
        },
      },
    ],
  },
  state: {},
  freshness: { updatedAt: '2026-10-09T09:50:00.000Z', updatedBy: 'agent' },
})

export const referenceUpdatedSurface = SurfaceSchema.parse({
  ...referenceSurface,
  tree: {
    ...referenceSurface.tree,
    children: referenceSurface.tree.children?.map((node) =>
      node.id === 'plan-detail'
        ? {
            ...node,
            props: {
              text: '**Repair confirmed for Friday at 10:00.**\n\nThe grocery list and Saturday afternoon are unchanged.',
            },
          }
        : node,
    ),
  },
  freshness: { updatedAt: referenceAt, updatedBy: 'agent' },
})

export const referenceSpace: SpaceWithSurfaces = {
  id: referenceSurface.spaceId,
  slug: 'reference-home',
  name: 'Home and family',
  archived: false,
  attention: 2,
  attentionRevision: 1,
  surfaces: [referenceSurface],
}
export const referenceSpaces: SpaceWithSurfaces[] = [
  referenceSpace,
  {
    id: 'spc-reference-work',
    slug: 'reference-work',
    name: 'Work — decisions, deadlines and follow-ups',
    archived: false,
    attention: 0,
    attentionRevision: 0,
    surfaces: [],
  },
  {
    id: SYSTEM_SPACE_ID,
    slug: 'system',
    name: 'System',
    archived: false,
    attention: 0,
    attentionRevision: 0,
    surfaces: [],
  },
]

export const referenceCatalog = SurfaceSchema.parse({
  ...catalogShowcaseSurface,
  tree: {
    ...catalogShowcaseSurface.tree,
    children: catalogShowcaseSurface.tree.children?.map((node) =>
      node.type === 'Pending'
        ? { ...node, props: { ...node.props, startedAt: referenceAt } }
        : node,
    ),
  },
})

export const referenceDecision: PendingDecision = {
  id: 'approval:reference-message',
  kind: 'approval',
  scope: { type: 'space', spaceId: referenceSpace.id },
  summary: 'Send the repair appointment details to the building manager',
  state: 'pending',
  createdAt: referenceAt,
  allowedResolutions: ['approve', 'reject'],
}

export function referenceTurn(state: 'accepted' | 'running' | 'interrupted'): ChatTimelineEntry {
  return {
    id: 'cte-reference',
    turnId: 'cht-reference',
    cursor: 'reference-cursor',
    position: 1,
    revision: 1,
    scope: { type: 'space', spaceId: referenceSpace.id },
    kind: 'user',
    message: {
      role: 'user',
      text: 'Organize the weekend and let me review anything that needs to be sent.',
    },
    createdAt: referenceAt,
    updatedAt: referenceAt,
    turnState: state,
    ...(state === 'interrupted'
      ? { error: 'Connection interrupted. Your request is preserved.' }
      : {}),
  }
}

export const referenceOnboarding = OnboardingStatusSchema.parse({
  required: true,
  completed: false,
  profile: 'vps',
  currentStep: 'first-space',
  steps: [{ id: 'first-space', status: 'pending' }],
  legacy: { openclaw: false, hermes: false },
  domain: { domain: null, tlsActive: true, accessMode: 'tailnet' },
  modelConnection: {
    vaultAvailable: true,
    connectedCount: 1,
    hasSelection: true,
    mockEnabled: false,
  },
  firstSpace: { suggestedName: 'Home', existingSpaces: [] },
  integrations: {
    gmail: { configured: false, hasCredentials: false },
    calendar: { configured: false, hasCredentials: false },
  },
})
