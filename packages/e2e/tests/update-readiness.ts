import { readFileSync } from 'node:fs'

// Read the production wrapper's literal default rather than maintain a second duration.
// Fail visibly if its declaration changes, so the E2E cannot silently fall back to an old budget.
const wrapper = readFileSync(new URL('../../../deploy/veduta-run', import.meta.url), 'utf8')
const seconds = wrapper.match(/^READY_TIMEOUT="\$\{VEDUTA_UPDATE_READY_TIMEOUT:-(\d+)\}"$/m)?.[1]
if (!seconds) throw new Error('Cannot read the production update readiness budget')
export const UPDATE_READINESS_BUDGET_MS = Number(seconds) * 1_000

interface ReadinessState {
  ready: boolean
  phase: string
  detail: string
}

/** One bounded deadline, with the last observed transaction phase in failure output. */
export async function waitForUpdateReadiness(
  probe: (remainingMs: number) => Promise<ReadinessState>,
  {
    budgetMs = UPDATE_READINESS_BUDGET_MS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  } = {},
): Promise<void> {
  const deadline = now() + budgetMs
  let last: ReadinessState = { ready: false, phase: 'unknown', detail: 'not yet probed' }
  while (now() < deadline) {
    last = await probe(deadline - now())
    if (last.ready && now() <= deadline) return
    const remaining = deadline - now()
    if (remaining > 0) await sleep(Math.min(2_000, remaining))
  }
  throw new Error(
    `Update readiness timed out after ${budgetMs}ms; phase=${last.phase}; last state: ${last.detail}`,
  )
}
