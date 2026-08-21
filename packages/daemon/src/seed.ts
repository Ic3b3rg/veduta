import type { Space, Surface } from '@veduta/protocol'
import { SpaceSchema, SurfaceSchema } from '@veduta/protocol'
import { buildRelativeTimeValidity } from './relative-time-surface.ts'

/**
 * Dev-profile seed data: the Home must never be empty on first run
 * (issue #1). One example Space with two Surfaces exercising bindings,
 * fast actions and freshness. Validated at boot — the daemon refuses
 * to start with an invalid seed rather than render garbage.
 */
export function seedSpaces(options: { relativeTimeNow?: () => Date; timeZone?: string } = {}): {
  spaces: Space[]
  surfaces: Surface[]
} {
  const relativeTimeNow = (options.relativeTimeNow ?? (() => new Date()))()
  const updatedAt = () => new Date().toISOString()
  const timeZone = options.timeZone ?? 'UTC'
  const health = SpaceSchema.parse({
    id: 'spc-health',
    slug: 'health',
    name: 'Health',
    archived: false,
  })

  const goal = SurfaceSchema.parse({
    id: 'srf-goal',
    spaceId: health.id,
    title: 'Weight goal',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Weight goal' } },
        {
          id: 'row',
          type: 'Row',
          children: [
            { id: 'current', type: 'Stat', binding: 'currentKg', props: { label: 'Current' } },
            { id: 'target', type: 'Stat', binding: 'targetKg', props: { label: 'Target' } },
          ],
        },
        { id: 'progress', type: 'Progress', binding: 'progress', props: { label: 'Progress' } },
        {
          id: 'hint',
          type: 'Caption',
          props: { text: 'Log a weight in chat to update this Surface.' },
        },
      ],
    },
    state: { currentKg: 82.3, targetKg: 77, progress: 0.25 },
    freshness: { updatedAt: updatedAt(), updatedBy: 'seed' },
  })

  const groceries = SurfaceSchema.parse({
    id: 'srf-groceries',
    spaceId: health.id,
    title: 'Groceries',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Groceries' } },
        ...['Milk', 'Eggs', 'Spinach', 'Chicken'].map((label) => ({
          id: `item-${label.toLowerCase()}`,
          type: 'Checkbox' as const,
          binding: label.toLowerCase(),
          props: { label },
          actions: [{ name: 'toggle', path: 'fast' as const, stateKey: label.toLowerCase() }],
        })),
      ],
    },
    state: { milk: false, eggs: false, spinach: true, chicken: false },
    freshness: { updatedAt: updatedAt(), updatedBy: 'seed' },
  })

  const meals = SurfaceSchema.parse({
    id: 'srf-meals',
    spaceId: health.id,
    title: 'Meals',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Meals' } },
        {
          id: 'summary',
          type: 'Row',
          children: [
            { id: 'meal-count', type: 'Stat', binding: 'mealCount', props: { label: 'Today' } },
            { id: 'last-meal', type: 'Stat', binding: 'lastMeal', props: { label: 'Last meal' } },
          ],
        },
        {
          id: 'meal-table',
          type: 'Table',
          binding: 'meals',
          props: { columns: ['time', 'meal'] },
        },
        {
          id: 'hint',
          type: 'Caption',
          props: { text: 'Ask the Agent to add a meal in chat to update this Surface.' },
        },
      ],
    },
    state: {
      mealRecords: [],
      meals: [],
      lastMeal: 'Nothing logged today',
      mealCount: 0,
    },
    freshness: { updatedAt: updatedAt(), updatedBy: 'seed' },
    validity: buildRelativeTimeValidity(
      {
        window: 'day',
        source: { stateKey: 'mealRecords', occurredAtKey: 'occurredAt' },
        projectionStateKeys: ['meals', 'lastMeal', 'mealCount'],
      },
      timeZone,
      relativeTimeNow,
    ),
  })

  return { spaces: [health], surfaces: [goal, groceries, meals] }
}
