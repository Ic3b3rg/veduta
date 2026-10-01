import { expect, type Page } from '@playwright/test'
import { surfaceCard } from './fast-actions-journey.ts'

export async function expectCompleteGymPlan(page: Page): Promise<void> {
  const plan = surfaceCard(page, 'Gym plan — 3 days')
  await expect(plan.getByRole('heading', { name: 'Session 1 — Strength' })).toBeVisible()
  await expect(plan.getByRole('heading', { name: 'Session 2 — Upper body' })).toBeVisible()
  await expect(plan.getByRole('heading', { name: 'Session 3 — Full body' })).toBeVisible()
  await expect(plan.getByRole('table')).toHaveCount(3)
  for (const cell of [
    'Squat',
    'Row',
    'Deadlift',
    '3 × 8',
    '3 × 10',
    '3 × 6',
    '90 seconds',
    '60 seconds',
    '120 seconds',
  ])
    await expect(plan.getByRole('cell', { name: cell, exact: true })).toBeVisible()
  await expect(plan.getByText(/Add one repetition before increasing load/)).toBeVisible()
  await expect(plan.getByText(/stop if you feel sharp pain/)).toBeVisible()
  await expect(plan.getByText('Keep a rest day between sessions.')).toBeVisible()
}
