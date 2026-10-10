// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fromPartial } from '@total-typescript/shoehorn'
import type { OnboardingStatus } from '@veduta/protocol'
import { afterEach, expect, it, vi } from 'vitest'
import { fetchAuthStatus, finishOnboarding } from './api.ts'
import { OnboardingWizard } from './onboarding-wizard.tsx'
import type * as ApiModule from './api.ts'

vi.mock('./api.ts', async (original) => ({
  ...(await original<typeof ApiModule>()),
  fetchAuthStatus: vi.fn(),
  finishOnboarding: vi.fn(),
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.resetAllMocks()
})

it('does not navigate back to Home when its restart check finishes after leaving the wizard', async () => {
  vi.useFakeTimers()
  vi.mocked(finishOnboarding).mockResolvedValue({ restarting: true, restartRequired: true })
  vi.mocked(fetchAuthStatus).mockResolvedValue({
    mode: 'production',
    passkeyRegistered: true,
    bootstrapRequired: false,
  })
  const onCompleted = vi.fn()
  const { unmount } = render(
    <OnboardingWizard
      status={fromPartial<OnboardingStatus>({
        profile: 'vps',
        required: true,
        completed: false,
        currentStep: 'finish',
        steps: [{ id: 'finish', status: 'pending' }],
      })}
      token="owner-session"
      onStatus={vi.fn()}
      onCompleted={onCompleted}
    />,
  )
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Finish' })))
  unmount()
  await act(async () => vi.advanceTimersByTimeAsync(2000))
  expect(onCompleted).not.toHaveBeenCalled()
})
