import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CONNECTIONS_FILE_NAME,
  ConnectionsFileSchema,
  ModelConnectionRecordSchema,
  assertSafeConnectionId,
  loadConnectionsConfig,
  saveConnectionsConfig,
  type ConnectionsFile,
} from './connections-config.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-connections-config-'))
  return rootDir
}

const validRecord = {
  id: 'anthropic' as const,
  method: 'anthropic-api-key' as const,
  provider: 'anthropic',
  label: 'Claude · API key',
  state: 'connected' as const,
  stateAt: '2026-08-09T10:00:00.000Z',
  enabledForFallback: false,
  createdAt: '2026-08-09T10:00:00.000Z',
  secretRef: 'secret://vault/anthropic',
}

describe('loadConnectionsConfig', () => {
  it('returns an empty file when connections.json is absent', () => {
    const dir = freshRoot()
    expect(loadConnectionsConfig(dir)).toEqual({
      version: 1,
      connections: [],
      mockEnabled: false,
    })
  })

  it('throws instead of resetting on invalid JSON', () => {
    const dir = freshRoot()
    writeFileSync(join(dir, CONNECTIONS_FILE_NAME), '{not json at all')
    expect(() => loadConnectionsConfig(dir)).toThrow(/invalid JSON in connections config/)
    expect(() => loadConnectionsConfig(dir)).toThrow(
      /refusing to silently reset Model connection state/,
    )
  })
})

describe('saveConnectionsConfig', () => {
  it('backs up the previous file before writing', () => {
    const dir = freshRoot()
    const first: ConnectionsFile = { version: 1, connections: [], mockEnabled: false }
    const second: ConnectionsFile = {
      version: 1,
      connections: [validRecord],
      mockEnabled: false,
    }
    saveConnectionsConfig(dir, first)
    saveConnectionsConfig(dir, second)

    const backups = readdirSync(dir).filter((entry) =>
      entry.startsWith(`${CONNECTIONS_FILE_NAME}.bak-`),
    )
    expect(backups).toHaveLength(1)
    expect(loadConnectionsConfig(dir).connections).toEqual([validRecord])
  })
})

describe('ConnectionsFileSchema', () => {
  it('rejects an unknown top-level key', () => {
    expect(
      ConnectionsFileSchema.safeParse({
        version: 1,
        connections: [],
        mockEnabled: false,
        unknownField: true,
      }).success,
    ).toBe(false)
  })
})

describe('ModelConnectionRecordSchema', () => {
  it('parses a valid record', () => {
    expect(ModelConnectionRecordSchema.safeParse(validRecord).success).toBe(true)
  })

  it('rejects a persisted device challenge field', () => {
    expect(
      ModelConnectionRecordSchema.safeParse({
        ...validRecord,
        challenge: {
          loginId: 'login-1',
          verificationUrl: 'https://chatgpt.com/device',
          userCode: 'ABCD-1234',
          expiresAt: '2026-08-09T10:15:00.000Z',
          expirySource: 'provider',
        },
      }).success,
    ).toBe(false)
  })
})

describe('assertSafeConnectionId', () => {
  it('accepts a reserved legacy provider id', () => {
    expect(() => assertSafeConnectionId('anthropic')).not.toThrow()
  })

  it('rejects "../escape"', () => {
    expect(() => assertSafeConnectionId('../escape')).toThrow(/unsafe Model connection id/)
  })
})
