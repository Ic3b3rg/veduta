import { join } from 'node:path'
import { fromPartial } from '@total-typescript/shoehorn'
import type { ModelRef } from './agent-runner.ts'
import {
  createFakeCodexTransport,
  fakeCodexDynamicToolRoundTrip,
  fakeCodexThreadStartResponse,
  fakeCodexTurnStartResponse,
  type FakeCodexTransport,
} from './codex-app-server-fake.ts'
import { createFakeProvider, fakeText, fakeToolCall } from './fake-provider.ts'
import type { AdapterContext } from './model-connection-adapter.ts'
import { codexSubscriptionAdapter } from './model-connection-codex.ts'
import { defaultRoutingConfig, type SecretResolver } from './model-routing.ts'
import {
  createProviderBridge,
  type ModelConnectionRuntime,
  type ProviderBridge,
} from './pi-provider-bridge.ts'

export type ModelConnectionMethod = 'byok' | 'chatgpt-subscription'

export interface ScriptedToolCall {
  toolName: string
  input: Record<string, unknown>
  resultText: string
}

export function scriptedByokProvider(calls: ScriptedToolCall[], finalText: string): ProviderBridge {
  const provider = createFakeProvider()
  provider.setResponses([
    ...calls.map((call) => ({ message: fakeToolCall(call.toolName, call.input) })),
    { message: fakeText(finalText) },
  ])
  return provider
}

/** Builds one Codex/fake turn that accepts each scripted call sequentially. */
export function scriptedSubscriptionTransport(
  calls: ScriptedToolCall[],
  finalText: string,
  turnKey: string,
): FakeCodexTransport {
  const threadId = `thread-${turnKey}`
  const turnId = `turn-${turnKey}`
  const fixtures = calls.map((call, index) =>
    fakeCodexDynamicToolRoundTrip({
      threadId,
      turnId,
      callId: `call-${index + 1}`,
      reverseRequestId: index,
      tool: call.toolName,
      input: call.input,
      resultText: call.resultText,
      finalText,
    }),
  )
  const first = fixtures[0]
  if (!first) throw new Error('a provider-parity scenario needs at least one tool call')

  const transport = createFakeCodexTransport({
    responses: {
      'thread/start': fakeCodexThreadStartResponse(threadId),
      'turn/start': () => {
        transport.emit(first.startNotification)
        transport.emitServerRequest(first.serverRequest)
        return fakeCodexTurnStartResponse(turnId)
      },
    },
    serverResponseStages: fixtures.map((fixture, index) => {
      const next = fixtures[index + 1]
      if (!next) return { notifications: fixture.continuationNotifications }
      return {
        notifications: [fixture.continuationNotifications[0]!, next.startNotification],
        serverRequests: [next.serverRequest],
      }
    }),
  })
  return transport
}

export function subscriptionProvider(options: {
  connectionId: string
  rootDir: string
  now: Date
  transport: FakeCodexTransport
}): ProviderBridge {
  const noSecrets: SecretResolver = { resolve: () => undefined }
  const context = fromPartial<AdapterContext>({
    connectionId: options.connectionId,
    rootDir: options.rootDir,
    vault: undefined,
    secrets: noSecrets,
    fetchImpl: fromPartial<typeof fetch>({}),
    now: () => options.now,
    probe: async () => {},
    codexHome: join(options.rootDir, 'codex', options.connectionId),
    codexTransport: async () => options.transport,
  })
  const runtime: ModelConnectionRuntime = {
    connectionId: options.connectionId,
    provider: 'openai',
    transport: 'subscription',
    stream: (request) => codexSubscriptionAdapter.stream!(context, request),
  }
  return createProviderBridge({
    config: defaultRoutingConfig(),
    secrets: noSecrets,
    connections: () => [runtime],
  })
}

export function modelForConnectionMethod(
  method: ModelConnectionMethod,
  connectionId: string,
): ModelRef {
  return method === 'byok'
    ? { provider: 'fake', modelId: 'fake-model', tier: 'reasoning' }
    : {
        provider: 'openai',
        modelId: 'gpt-5-codex',
        tier: 'reasoning',
        connectionId,
      }
}
