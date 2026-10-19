import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ModelConnectionChallenge } from '@veduta/protocol'
import { CLAUDE_CODE_VERSION, type ClaudeCodeClient } from './claude-code-process.ts'
import {
  ModelConnectionError,
  type AdapterContext,
  type AuthorizeInput,
  type SubscriptionModelConnectionAdapter,
} from './model-connection-adapter.ts'
import type { SubscriptionStreamRequest } from './pi-provider-bridge.ts'

export type ClaudeCodeTransport = Pick<
  ClaudeCodeClient,
  'checkVersion' | 'login' | 'completeLogin' | 'status' | 'catalog' | 'infer' | 'remove'
>

/** CLI-managed subscription inference, with no bearer-token access (ADR-0014, issue #285). */
export function createClaudeSubscriptionAdapter(
  client: ClaudeCodeTransport,
): SubscriptionModelConnectionAdapter {
  async function authorize(ctx: AdapterContext, input: AuthorizeInput) {
    if (input.apiKey !== undefined)
      throw new ModelConnectionError(
        'rejected',
        'This connection uses Claude Code subscription sign-in; do not submit an API key',
      )
    await client.checkVersion(ctx)
    if (input.authorizationCode !== undefined && input.loginId !== undefined) {
      await client.completeLogin(ctx, input.loginId, input.authorizationCode)
      const status = await client.status(ctx)
      if (status.state !== 'connected')
        throw new ModelConnectionError(
          'expired',
          'Claude Code sign-in did not complete; start it again',
        )
      return { state: 'connected' as const, ...(status.account ? { account: status.account } : {}) }
    }
    return { state: 'waiting-for-user' as const, challenge: await client.login(ctx) }
  }

  async function refresh(ctx: AdapterContext, challenge?: ModelConnectionChallenge) {
    await client.checkVersion(ctx)
    return client.status(ctx, challenge?.loginId)
  }

  async function* stream(ctx: AdapterContext, request: SubscriptionStreamRequest) {
    await client.checkVersion(ctx)
    const names = request.prompt.tools.map((tool) => tool.name)
    const toolSchema =
      names.length === 0
        ? { type: 'null' }
        : {
            anyOf: [
              { type: 'null' },
              {
                type: 'object',
                properties: {
                  name: { type: 'string', enum: names },
                  inputJson: {
                    type: 'string',
                    description: 'A JSON object matching this Veduta tool input schema',
                  },
                },
                required: ['name', 'inputJson'],
                additionalProperties: false,
              },
            ],
          }
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' }, toolCall: toolSchema },
      required: ['text', 'toolCall'],
      additionalProperties: false,
    }
    const prompt = JSON.stringify({
      ...request.prompt,
      responseInstructions:
        'Return text and either null or one toolCall. Request a tool whenever work requires it. Tool definitions are the complete allowed set. Veduta executes the request and supplies its result in the next conversation. Never claim an effect before its successful tool result. inputJson must encode a JSON object matching the chosen tool input schema.',
    })
    const raw = await client.infer(ctx, request.modelId, prompt, schema, request.signal)
    const parsed = z
      .object({
        text: z.string(),
        toolCall: z.object({ name: z.string(), inputJson: z.string() }).strict().nullable(),
      })
      .strict()
      .safeParse(raw)
    if (!parsed.success)
      throw new ModelConnectionError(
        'unsupported',
        'Claude Code returned an invalid Veduta response',
      )
    let input: Record<string, unknown> | undefined
    const call = parsed.data.toolCall
    if (call) {
      if (!names.includes(call.name))
        throw new ModelConnectionError(
          'unsupported',
          'Claude Code requested a tool that is not allowed for this turn',
        )
      try {
        input = z.record(z.unknown()).parse(JSON.parse(call.inputJson))
      } catch {
        throw new ModelConnectionError('unsupported', 'Claude Code returned invalid tool arguments')
      }
    }
    if (parsed.data.text) yield { type: 'text-delta' as const, text: parsed.data.text }
    if (call && input)
      yield { type: 'tool-call' as const, toolCallId: randomUUID(), toolName: call.name, input }
  }

  return {
    methodId: 'claude-subscription',
    providerName: 'anthropic',
    providerDisplayName: 'Claude',
    methodDisplayName: 'Subscription',
    capabilities: {
      authorization: 'browser-code',
      refresh: 'automatic',
      revocation: 'local-only',
      metered: true,
    },
    primaryInference: { transport: 'subscription', stream },
    async availability(env) {
      try {
        await client.checkVersion({
          connectionId: 'availability-probe',
          rootDir: env.rootDir,
          env: env.env,
          now: () => new Date(),
        })
        return { available: true }
      } catch (error) {
        return {
          available: false,
          reason:
            error instanceof ModelConnectionError
              ? error.message
              : `Claude Code ${CLAUDE_CODE_VERSION} is unavailable`,
          docsUrl: 'https://code.claude.com/docs/en/setup',
        }
      }
    },
    authorize,
    refresh,
    async catalog(ctx) {
      await client.checkVersion(ctx)
      return client.catalog(ctx)
    },
    async verify(ctx, modelId) {
      await ctx.probe(modelId)
    },
    async revoke(ctx) {
      await client.remove(ctx)
      return {
        providerRevoked: false,
        note: 'The local Claude Code login was removed. Review active sessions in your Claude account to confirm remote revocation.',
      }
    },
  }
}
