import type { FakeCodexTransport } from './codex-app-server-fake.ts'
import { normalizeStableValue } from './provider-parity-test-support.ts'
import type { PiChatContext, ProviderBridge } from './pi-provider-bridge.ts'

export interface ProviderToolDefinition {
  name: string
  description: string
  inputSchema: unknown
}

export interface SubscriptionTransportObservation {
  requestMethods: string[]
  responseIds: number[]
  toolResultTexts: string[]
  toolResultSuccess: boolean[]
  turnStartText: string
}

/** Records the complete definition set supplied to each BYOK model call. */
export function captureProviderDefinitions(
  provider: ProviderBridge,
  observations: ProviderToolDefinition[][],
): ProviderBridge {
  return {
    ...provider,
    streamFn(model, context, options) {
      observations.push(definitionsFromPiContext(context))
      return provider.streamFn(model, context, options)
    },
  }
}

/** Returns the stable definition set shared by every model call in one turn. */
export function consistentProviderDefinitions(
  observations: ProviderToolDefinition[][],
): ProviderToolDefinition[] {
  const first = observations[0]
  if (!first) throw new Error('provider received no tool definitions')
  const expected = JSON.stringify(first)
  if (observations.some((definitions) => JSON.stringify(definitions) !== expected)) {
    throw new Error('provider received different gated definitions within one turn')
  }
  return first
}

/** Reads the provider-neutral definitions translated into Codex dynamic tools. */
export function subscriptionDefinitions(transport: FakeCodexTransport): ProviderToolDefinition[] {
  const request = transport.requests.find((candidate) => candidate.method === 'thread/start')
  const params = recordValue(request?.params, 'thread/start params')
  const dynamicTools = params['dynamicTools']
  if (!Array.isArray(dynamicTools)) throw new Error('thread/start carried no dynamicTools array')
  return dynamicTools.map((value) => {
    const definition = recordValue(value, 'dynamic tool definition')
    if (definition['type'] !== 'function') {
      throw new Error('Codex received a non-function dynamic tool definition')
    }
    return {
      name: stringValue(definition['name'], 'dynamic tool name'),
      description: stringValue(definition['description'], 'dynamic tool description'),
      inputSchema: normalizeStableValue(definition['inputSchema']),
    }
  })
}

/** Captures the observable Codex request/result transcript for a parity turn. */
export function observeSubscriptionTransport(
  transport: FakeCodexTransport,
): SubscriptionTransportObservation {
  const turnStart = transport.requests.find((request) => request.method === 'turn/start')
  const params = recordValue(turnStart?.params, 'turn/start params')
  const input = params['input']
  if (!Array.isArray(input)) throw new Error('turn/start carried no input array')
  const firstInput = recordValue(input[0], 'turn/start text input')
  return {
    requestMethods: transport.requests.map((request) => request.method),
    responseIds: transport.serverResponses.map((response) => Number(response.id)),
    toolResultTexts: transport.serverResponses.map((response) => {
      const result = recordValue(response.result, 'dynamic tool response')
      const contentItems = result['contentItems']
      if (!Array.isArray(contentItems)) throw new Error('dynamic tool response has no contentItems')
      return contentItems
        .map((item) => stringValue(recordValue(item, 'tool response item')['text'], 'tool text'))
        .join('\n')
    }),
    toolResultSuccess: transport.serverResponses.map((response) => {
      const success = recordValue(response.result, 'dynamic tool response')['success']
      if (typeof success !== 'boolean') throw new Error('dynamic tool response has no success flag')
      return success
    }),
    turnStartText: stringValue(firstInput['text'], 'turn/start input text'),
  }
}

function definitionsFromPiContext(context: PiChatContext): ProviderToolDefinition[] {
  return (context.tools ?? []).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: normalizeStableValue(tool.parameters),
  }))
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} is not a string`)
  return value
}
