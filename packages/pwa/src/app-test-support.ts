import type { AuthStatus } from '@veduta/protocol'
import { cleanup } from '@testing-library/react'
import { vi } from 'vitest'
import type * as ApiModule from './api.ts'
import {
  installMotionBrowser,
  restoreMotionBrowser,
  type MotionAnimationCall,
} from './motion-test-browser.ts'

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
)

export function createAppApiMock(actual: typeof ApiModule) {
  return {
    ...actual,
    fetchAuthStatus: vi.fn(),
    fetchSpaces: vi.fn(),
    fetchOnboardingStatus: vi.fn(),
    connectGateway: vi.fn(() => ({ close: vi.fn(), sendChat: vi.fn(() => false) })),
    invokeFastAction: vi.fn(),
    moveSurface: vi.fn(),
    fetchModelConnections: vi.fn(),
    finishOnboarding: vi.fn(),
    resolvePendingDecision: vi.fn(),
  }
}

export function installAppTestBrowser(): {
  atomAnimations: MotionAnimationCall[]
  scrollIntoView: ReturnType<typeof vi.fn>
} {
  const atomAnimations = installMotionBrowser(false).calls
  const scrollIntoView = vi.fn()
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: scrollIntoView,
  })
  return { atomAnimations, scrollIntoView }
}

export function resetAppTestBrowser(): void {
  cleanup()
  localStorage.clear()
  window.history.replaceState({}, '', '/')
  Reflect.deleteProperty(navigator, 'serviceWorker')
  vi.clearAllMocks()
  restoreMotionBrowser()
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
  }
}

export function authStatus(overrides: Partial<AuthStatus> = {}): AuthStatus {
  return { mode: 'production', bootstrapRequired: false, passkeyRegistered: true, ...overrides }
}
