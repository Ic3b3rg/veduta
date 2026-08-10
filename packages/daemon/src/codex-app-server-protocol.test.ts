import { describe, expect, it } from 'vitest'
import {
  AccountReadResponseSchema,
  CodexProtocolError,
  InitializeResponseSchema,
  ItemNotificationSchema,
  LoginStartResponseSchema,
  LogoutResponseSchema,
  ModelListResponseSchema,
  parseCodexNotification,
  parseCodexResponse,
  ThreadStartResponseSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
} from './codex-app-server-protocol.ts'

// Complete entry captured from the pinned binary's unauthenticated
// `model/list` response. Expectations below stay literal and independent of
// the schema under test while fixtures mirror the real upstream structure.
const OBSERVED_MODEL_ENTRY = {
  id: 'gpt-5.6-terra',
  model: 'gpt-5.6-terra',
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: 'GPT-5.6-Terra',
  description: 'Balanced agentic coding model for everyday work.',
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
    {
      reasoningEffort: 'medium',
      description: 'Balances speed and reasoning depth for everyday tasks',
    },
    { reasoningEffort: 'high', description: 'Greater reasoning depth for complex problems' },
    { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth for complex problems' },
    { reasoningEffort: 'max', description: 'Maximum reasoning depth for the hardest problems' },
    {
      reasoningEffort: 'ultra',
      description: 'Maximum reasoning with automatic task delegation',
    },
  ],
  defaultReasoningEffort: 'medium',
  inputModalities: ['text', 'image'],
  supportsPersonality: false,
  additionalSpeedTiers: ['fast'],
  serviceTiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed, increased usage' }],
  defaultServiceTier: null,
  isDefault: false,
}

describe('parseCodexResponse', () => {
  it('parses a well-formed initialize response', () => {
    // The real shape observed 2026-08-10 against the pinned 0.146.1 binary
    // (`InitializeResponseSchema`'s own doc comment): no `version` field at
    // all, the version lives inside `userAgent`.
    const parsed = parseCodexResponse(InitializeResponseSchema, 'initialize', {
      userAgent: 'veduta/0.146.1 (Mac OS 26.5.1; arm64) unknown (veduta; 0.0.0)',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    })
    expect(parsed.userAgent).toBe('veduta/0.146.1 (Mac OS 26.5.1; arm64) unknown (veduta; 0.0.0)')
  })

  it('parses a well-formed account/login/start response', () => {
    const parsed = parseCodexResponse(LoginStartResponseSchema, 'account/login/start', {
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
    expect(parsed).toEqual({
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    })
  })

  it('parses a model/list response with cursor pagination', () => {
    const parsed = parseCodexResponse(ModelListResponseSchema, 'model/list', {
      data: [{ ...OBSERVED_MODEL_ENTRY, isDefault: true }],
      nextCursor: 'page-2',
    })
    expect(parsed.data).toHaveLength(1)
    expect(parsed.nextCursor).toBe('page-2')
  })

  it('parses a model/list catalog entry carrying fields this build does not model', () => {
    // Observed 2026-08-10: a real entry carries roughly a dozen further
    // fields (`CodexModelEntrySchema`'s own doc comment) — `.passthrough()`
    // must let them through rather than failing the parse.
    const parsed = parseCodexResponse(ModelListResponseSchema, 'model/list', {
      data: [{ ...OBSERVED_MODEL_ENTRY, upstreamModelField: true }],
      nextCursor: null,
    })
    expect(parsed.data[0]?.id).toBe('gpt-5.6-terra')
    expect(parsed.nextCursor).toBeNull()
  })

  it('parses an account/read response reporting no signed-in account', () => {
    // The real shape observed 2026-08-10 with no ChatGPT account signed in
    // (`AccountReadResponseSchema`'s own doc comment).
    const parsed = parseCodexResponse(AccountReadResponseSchema, 'account/read', {
      account: null,
      requiresOpenaiAuth: true,
    })
    expect(parsed).toEqual({ account: null, requiresOpenaiAuth: true })
  })

  it('parses an initialize response carrying unknown extra keys', () => {
    const parsed = parseCodexResponse(InitializeResponseSchema, 'initialize', {
      userAgent: 'veduta/0.146.1 (Mac OS 26.5.1; arm64) unknown (veduta; 0.0.0)',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
      upstreamAddition: { inert: true },
    })
    expect(parsed.userAgent).toContain('0.146.1')
  })

  it('parses an account/login/start response carrying unknown extra keys', () => {
    const parsed = parseCodexResponse(LoginStartResponseSchema, 'account/login/start', {
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
      intervalSeconds: 5,
    })
    expect(parsed.type).toBe('chatgptDeviceCode')
  })

  it('parses an account/read response carrying unknown extra keys', () => {
    const parsed = parseCodexResponse(AccountReadResponseSchema, 'account/read', {
      account: { planType: 'ChatGPT Plus', upstreamAccountField: true },
      requiresOpenaiAuth: false,
      upstreamEnvelopeField: true,
    })
    expect(parsed.account?.planType).toBe('ChatGPT Plus')
  })

  it('parses a model/list response carrying unknown extra keys', () => {
    const parsed = parseCodexResponse(ModelListResponseSchema, 'model/list', {
      data: [OBSERVED_MODEL_ENTRY],
      nextCursor: null,
      upstreamPageField: true,
    })
    expect(parsed.data[0]?.id).toBe('gpt-5.6-terra')
  })

  it('parses an account/logout response carrying unknown extra keys', () => {
    expect(
      parseCodexResponse(LogoutResponseSchema, 'account/logout', { status: 'loggedOut' }),
    ).toBeDefined()
  })

  it('throws CodexProtocolError, naming the method, when a required field is missing', () => {
    const malformed = {
      type: 'chatgptDeviceCode',
      loginId: 'login-1',
      userCode: 'ABCD-1234',
    }
    expect(() =>
      parseCodexResponse(LoginStartResponseSchema, 'account/login/start', malformed),
    ).toThrow(CodexProtocolError)
    try {
      parseCodexResponse(LoginStartResponseSchema, 'account/login/start', malformed)
    } catch (error) {
      expect(error).toBeInstanceOf(CodexProtocolError)
      expect((error as CodexProtocolError).method).toBe('account/login/start')
      expect((error as CodexProtocolError).message).toContain('account/login/start')
    }
  })
})

describe('parseCodexNotification', () => {
  it('parses a recognized method and returns its typed required params', () => {
    const notification = parseCodexNotification('account/login/completed', { loginId: 'login-1' })
    expect(notification).toEqual({
      method: 'account/login/completed',
      params: { loginId: 'login-1' },
    })
  })

  it('parses a recognized method carrying unknown extra fields', () => {
    const notification = parseCodexNotification('account/login/completed', {
      loginId: 'login-1',
      success: false,
      error: 'Login was not completed',
    })
    expect(notification.method).toBe('account/login/completed')
    expect(notification.params).toMatchObject({ loginId: 'login-1' })
  })

  it('parses an account/updated payload carrying unknown extra fields', () => {
    const notification = parseCodexNotification('account/updated', {
      planType: 'ChatGPT Plus',
    })
    expect(notification.method).toBe('account/updated')
  })

  it('ignores an unknown notification method, passing params through unparsed', () => {
    const notification = parseCodexNotification('codex/some-future-notification', { anything: 42 })
    expect(notification).toEqual({
      method: 'codex/some-future-notification',
      params: { anything: 42 },
    })
  })
})

describe('the inference-seam schemas (issue #47)', () => {
  it('parses a thread/start response', () => {
    const parsed = parseCodexResponse(ThreadStartResponseSchema, 'thread/start', {
      threadId: 'thread-1',
      modelProvider: 'openai',
    })
    expect(parsed.threadId).toBe('thread-1')
  })

  it('parses a turn/start response', () => {
    const parsed = parseCodexResponse(TurnStartResponseSchema, 'turn/start', {
      turnId: 'turn-1',
      status: 'inProgress',
    })
    expect(parsed.turnId).toBe('turn-1')
  })

  it('parses an agentMessage item notification carrying an incremental delta', () => {
    const parsed = parseCodexResponse(ItemNotificationSchema, 'item/updated', {
      threadId: 'thread-1',
      item: { type: 'agentMessage', delta: 'hel' },
      sequenceNumber: 1,
    })
    expect(parsed.item).toEqual({ type: 'agentMessage', delta: 'hel' })
  })

  it('parses an item notification whose type this build has never seen, without throwing', () => {
    // `CodexItemSchema`'s own doc comment: the item body is deliberately
    // `.passthrough()` so a command-execution/patch/MCP-tool-call/unknown
    // item still parses — only its `type` matters to the refusal decision
    // `model-connection-codex.ts`'s `stream()` makes from it, never its
    // other fields.
    const parsed = parseCodexResponse(ItemNotificationSchema, 'item/updated', {
      threadId: 'thread-1',
      item: { type: 'commandExecution', command: 'rm -rf /', exitCode: 1 },
    })
    expect(parsed.item.type).toBe('commandExecution')
  })

  it('parses a turn/completed notification', () => {
    const parsed = parseCodexResponse(TurnCompletedNotificationSchema, 'turn/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
    })
    expect(parsed.threadId).toBe('thread-1')
    expect(parsed.turnId).toBe('turn-1')
  })

  it('throws CodexProtocolError when an item notification is missing its item', () => {
    expect(() =>
      parseCodexResponse(ItemNotificationSchema, 'item/updated', { threadId: 'thread-1' }),
    ).toThrow(CodexProtocolError)
  })
})
