import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConnectionsConfig } from './connections-config.ts'
import { reconcileByokConnections } from './model-connection-migration.ts'
import { defaultRoutingConfig, saveRoutingConfig, type RoutingConfig } from './model-routing.ts'

let rootDir: string | undefined

afterEach(() => {
  if (rootDir) rmSync(rootDir, { recursive: true, force: true })
  rootDir = undefined
})

function freshRoot(): string {
  rootDir = mkdtempSync(join(tmpdir(), 'veduta-connection-migration-'))
  return rootDir
}

const NOW = () => new Date('2026-08-09T10:00:00.000Z')

/** A `RoutingConfig` with every provider key pointed at a vault-style ref, all resolving. */
function routingWithVaultKeys(): RoutingConfig {
  const base = defaultRoutingConfig()
  return {
    ...base,
    providerKeys: {
      anthropic: 'secret://vault/anthropic',
      openai: 'secret://vault/openai',
      openrouter: 'secret://vault/openrouter',
    },
  }
}

function resolverFor(values: Record<string, string>): {
  resolve: (ref: string) => string | undefined
} {
  return { resolve: (ref) => values[ref] }
}

describe('reconcileByokConnections', () => {
  it('creates one connection per provider with a resolvable vault key', () => {
    const dir = freshRoot()
    const routing = routingWithVaultKeys()
    const secrets = resolverFor({
      'secret://vault/anthropic': 'sk-ant-real',
      'secret://vault/openai': 'sk-openai-real',
      'secret://vault/openrouter': 'sk-openrouter-real',
    })

    const wrote = reconcileByokConnections({ rootDir: dir, routing, secrets, now: NOW })

    expect(wrote).toBe(true)
    const file = loadConnectionsConfig(dir)
    expect(file.connections.map((connection) => connection.id).sort()).toEqual([
      'anthropic',
      'openai',
      'openrouter',
    ])
    for (const connection of file.connections) {
      expect(connection.state).toBe('connected')
      expect(connection.enabledForFallback).toBe(false)
    }
    // Migration never sets a selection — the routed model must stay exactly
    // what `routing.json` already named (issues/047-model-connections.md).
    expect(file.selection).toBeUndefined()
    const anthropic = file.connections.find((connection) => connection.id === 'anthropic')
    expect(anthropic?.selectedModelId).toBe('claude-sonnet-5')
    expect(anthropic?.label).toBe('Claude · API key')
  })

  it('is idempotent — a second run writes nothing', () => {
    const dir = freshRoot()
    const routing = routingWithVaultKeys()
    const secrets = resolverFor({
      'secret://vault/anthropic': 'sk-ant-real',
      'secret://vault/openai': 'sk-openai-real',
      'secret://vault/openrouter': 'sk-openrouter-real',
    })

    reconcileByokConnections({ rootDir: dir, routing, secrets, now: NOW })
    const before = readFileSync(join(dir, 'connections.json'), 'utf8')

    const wroteAgain = reconcileByokConnections({ rootDir: dir, routing, secrets, now: NOW })

    expect(wroteAgain).toBe(false)
    expect(readFileSync(join(dir, 'connections.json'), 'utf8')).toBe(before)
  })

  it('ignores an unresolvable secret://env default', () => {
    const dir = freshRoot()
    // The shipped default routing config: every providerKeys entry points
    // at an env var nothing has set.
    const routing = defaultRoutingConfig()
    const secrets = resolverFor({})

    const wrote = reconcileByokConnections({ rootDir: dir, routing, secrets, now: NOW })

    expect(wrote).toBe(false)
    expect(loadConnectionsConfig(dir).connections).toEqual([])
  })

  it('copies a resolvable secret://env ref verbatim', () => {
    const dir = freshRoot()
    const routing = defaultRoutingConfig()
    const secrets = resolverFor({ 'secret://env/ANTHROPIC_API_KEY': 'sk-ant-from-env' })

    reconcileByokConnections({ rootDir: dir, routing, secrets, now: NOW })

    const anthropic = loadConnectionsConfig(dir).connections.find(
      (connection) => connection.id === 'anthropic',
    )
    expect(anthropic?.secretRef).toBe('secret://env/ANTHROPIC_API_KEY')
  })

  it('never writes routing.json', () => {
    const dir = freshRoot()
    const routing = routingWithVaultKeys()
    saveRoutingConfig(dir, routing)
    const before = readFileSync(join(dir, 'routing.json'), 'utf8')
    const beforeMtime = statSync(join(dir, 'routing.json')).mtimeMs

    const secrets = resolverFor({
      'secret://vault/anthropic': 'sk-ant-real',
      'secret://vault/openai': 'sk-openai-real',
      'secret://vault/openrouter': 'sk-openrouter-real',
    })
    reconcileByokConnections({ rootDir: dir, routing, secrets, now: NOW })

    expect(existsSync(join(dir, 'routing.json'))).toBe(true)
    expect(readFileSync(join(dir, 'routing.json'), 'utf8')).toBe(before)
    expect(statSync(join(dir, 'routing.json')).mtimeMs).toBe(beforeMtime)
  })
})
