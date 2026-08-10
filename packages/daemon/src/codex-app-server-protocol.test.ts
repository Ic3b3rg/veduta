import { describe, expect, it } from 'vitest'
import {
  AccountReadResponseSchema,
  CodexProtocolError,
  InitializeResponseSchema,
  ItemNotificationSchema,
  LoginStartResponseSchema,
  ModelListResponseSchema,
  parseCodexNotification,
  parseCodexResponse,
  ThreadStartResponseSchema,
  TurnCompletedNotificationSchema,
  TurnStartResponseSchema,
} from './codex-app-server-protocol.ts'

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
      loginId: 'login-1',
      verificationUrl: 'https://chatgpt.com/device',
      userCode: 'ABCD-1234',
    })
    expect(parsed).toEqual({
      loginId: 'login-1',
      verificationUrl: 'https://chatgpt.com/device',
      userCode: 'ABCD-1234',
    })
  })

  it('parses a model/list response with cursor pagination', () => {
    const parsed = parseCodexResponse(ModelListResponseSchema, 'model/list', {
      data: [{ id: 'gpt-5-codex', displayName: 'GPT-5 Codex', isDefault: true }],
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
      data: [
        {
          id: 'gpt-5-codex',
          model: 'gpt-5-codex',
          displayName: 'GPT-5 Codex',
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'fast' }],
        },
      ],
      nextCursor: null,
    })
    expect(parsed.data[0]?.id).toBe('gpt-5-codex')
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

  it('throws CodexProtocolError, naming the method, on an unexpected extra field', () => {
    const wellFormed = {
      userAgent: 'veduta/0.146.1 (Mac OS 26.5.1; arm64) unknown (veduta; 0.0.0)',
      codexHome: '/home/user/.codex',
      platformFamily: 'unix',
      platformOs: 'macos',
    }
    expect(() =>
      parseCodexResponse(InitializeResponseSchema, 'initialize', {
        ...wellFormed,
        unexpectedField: 'drift',
      }),
    ).toThrow(CodexProtocolError)
    try {
      parseCodexResponse(InitializeResponseSchema, 'initialize', { ...wellFormed, extra: true })
    } catch (error) {
      expect(error).toBeInstanceOf(CodexProtocolError)
      expect((error as CodexProtocolError).method).toBe('initialize')
      expect((error as CodexProtocolError).message).toContain('initialize')
    }
  })

  it('throws CodexProtocolError when a required field is missing', () => {
    expect(() =>
      parseCodexResponse(LoginStartResponseSchema, 'account/login/start', { loginId: 'login-1' }),
    ).toThrow(CodexProtocolError)
  })
})

describe('parseCodexNotification', () => {
  it('strict-parses a recognized method and returns its typed params', () => {
    const notification = parseCodexNotification('account/login/completed', { loginId: 'login-1' })
    expect(notification).toEqual({
      method: 'account/login/completed',
      params: { loginId: 'login-1' },
    })
  })

  it('throws CodexProtocolError when a recognized method carries an unexpected field', () => {
    expect(() =>
      parseCodexNotification('account/login/completed', { loginId: 'login-1', extra: 'drift' }),
    ).toThrow(CodexProtocolError)
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
    })
    expect(parsed).toEqual({ threadId: 'thread-1' })
  })

  it('parses a turn/start response', () => {
    const parsed = parseCodexResponse(TurnStartResponseSchema, 'turn/start', { turnId: 'turn-1' })
    expect(parsed).toEqual({ turnId: 'turn-1' })
  })

  it('parses an agentMessage item notification carrying an incremental delta', () => {
    const parsed = parseCodexResponse(ItemNotificationSchema, 'item/updated', {
      threadId: 'thread-1',
      item: { type: 'agentMessage', delta: 'hel' },
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
    })
    expect(parsed).toEqual({ threadId: 'thread-1', turnId: 'turn-1' })
  })

  it('throws CodexProtocolError when an item notification is missing its item', () => {
    expect(() =>
      parseCodexResponse(ItemNotificationSchema, 'item/updated', { threadId: 'thread-1' }),
    ).toThrow(CodexProtocolError)
  })
})
