import { describe, expect, it } from 'vitest'
import {
  AccountReadResponseSchema,
  CodexProtocolError,
  InitializeResponseSchema,
  LoginStartResponseSchema,
  ModelListResponseSchema,
  parseCodexNotification,
  parseCodexResponse,
} from './codex-app-server-protocol.ts'

describe('parseCodexResponse', () => {
  it('parses a well-formed initialize response', () => {
    const parsed = parseCodexResponse(InitializeResponseSchema, 'initialize', {
      version: '0.146.1',
    })
    expect(parsed.version).toBe('0.146.1')
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
      models: [{ id: 'gpt-5-codex', label: 'GPT-5 Codex', isDefault: true }],
      nextCursor: 'page-2',
    })
    expect(parsed.models).toHaveLength(1)
    expect(parsed.nextCursor).toBe('page-2')
  })

  it('parses an account/read response missing every optional field', () => {
    const parsed = parseCodexResponse(AccountReadResponseSchema, 'account/read', {})
    expect(parsed).toEqual({})
  })

  it('throws CodexProtocolError, naming the method, on an unexpected extra field', () => {
    expect(() =>
      parseCodexResponse(InitializeResponseSchema, 'initialize', {
        version: '0.146.1',
        unexpectedField: 'drift',
      }),
    ).toThrow(CodexProtocolError)
    try {
      parseCodexResponse(InitializeResponseSchema, 'initialize', {
        version: '0.146.1',
        extra: true,
      })
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
