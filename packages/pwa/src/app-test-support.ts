import type { AuthStatus, ModelConnectionsSnapshot, Surface } from '@veduta/protocol'
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
    fetchPendingDecisions: vi.fn(async () => ({ revision: 0, decisions: [] })),
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

export function connectedModelConnectionsSnapshot(): ModelConnectionsSnapshot {
  return {
    vaultAvailable: true,
    mockEnabled: false,
    mockControlAvailable: false,
    methods: [],
    connections: [
      {
        id: 'a1a1a1a1-0000-4000-8000-000000000001',
        method: 'anthropic-api-key',
        provider: 'anthropic',
        label: 'Claude',
        state: 'connected',
        stateAt: '2026-08-09T00:00:00.000Z',
        enabledForFallback: false,
        createdAt: '2026-08-09T00:00:00.000Z',
        selectedModelId: 'claude-sonnet-5',
        catalog: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet', routable: true }],
      },
    ],
    selection: { connectionId: 'a1a1a1a1-0000-4000-8000-000000000001', modelId: 'claude-sonnet-5' },
  }
}

export function appTestSurface(id: string, title: string): Surface {
  return {
    id,
    spaceId: 'spc-health',
    title,
    tree: { id: 'root', type: 'Box' },
    state: {},
    freshness: { updatedAt: '2026-08-16T10:00:00.000Z', updatedBy: 'agent' },
    pinned: false,
    pinnable: true,
  }
}
