import { expect, test } from '@playwright/test'
import { UPDATE_READINESS_BUDGET_MS, waitForUpdateReadiness } from './update-readiness.ts'

function slowRecovery(budgetMs: number) {
  let elapsed = 0
  return waitForUpdateReadiness(
    async () => ({
      ready: elapsed >= 6 * 60_000,
      phase: elapsed >= 6 * 60_000 ? 'rolled-back' : 'serving-check',
      detail: `health=${elapsed >= 6 * 60_000 ? '9.9.9' : 'unavailable'}`,
    }),
    {
      budgetMs,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms
      },
    },
  )
}

test('slow recovery exceeds the old five minutes but fits the production budget', async () => {
  await expect(slowRecovery(5 * 60_000)).rejects.toThrow('phase=serving-check')
  await expect(slowRecovery(UPDATE_READINESS_BUDGET_MS)).resolves.toBeUndefined()
})

test('stuck staged apply fails at the bounded deadline with phase and last state', async () => {
  let elapsed = 0
  await expect(
    waitForUpdateReadiness(
      async () => ({
        ready: false,
        phase: 'staged',
        detail: 'health=unavailable; outcome=missing',
      }),
      {
        now: () => elapsed,
        sleep: async (ms) => {
          elapsed += ms
        },
      },
    ),
  ).rejects.toThrow(
    `Update readiness timed out after ${UPDATE_READINESS_BUDGET_MS}ms; phase=staged; last state: health=unavailable; outcome=missing`,
  )
  expect(elapsed).toBe(UPDATE_READINESS_BUDGET_MS)
})
