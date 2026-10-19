import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fromPartial } from '@total-typescript/shoehorn'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeCodeClient, claudeConfigDir } from './claude-code-process.ts'
import { createClaudeSubscriptionAdapter } from './model-connection-claude.ts'
import type { AdapterContext } from './model-connection-adapter.ts'
import type { SubscriptionStreamRequest } from './pi-provider-bridge.ts'

const fixture = fileURLToPath(new URL('./claude-code-fixture.mjs', import.meta.url))
const roots: string[] = []
const clients: ClaudeCodeClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function setup() {
  const rootDir = mkdtempSync(join(tmpdir(), 'veduta-claude-'))
  roots.push(rootDir)
  const ctx = fromPartial<AdapterContext>({
    rootDir,
    connectionId: '00000000-0000-4000-8000-000000000001',
    now: () => new Date(),
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: 'ambient-secret',
      CLAUDE_CODE_OAUTH_TOKEN: 'ambient-token',
    },
    probe: vi.fn(async () => {}),
  })
  const client = new ClaudeCodeClient(() => fixture)
  clients.push(client)
  const adapter = createClaudeSubscriptionAdapter(client)
  return { ctx, client, adapter, dir: claudeConfigDir(ctx) }
}
const request = fromPartial<SubscriptionStreamRequest>({
  modelId: 'claude-test-model',
  prompt: {
    systemPrompt: 'You are the Veduta Agent',
    messages: [{ role: 'user', text: 'Create a Surface' }],
    tools: [
      {
        name: 'create_surface',
        description: 'Create a Surface',
        inputSchema: {
          type: 'object',
          properties: { title: { type: 'string' } },
          required: ['title'],
        },
      },
    ],
  },
})
async function collect(stream: AsyncIterable<unknown>) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}

describe('Claude Code subscription Model connection', () => {
  it('authorizes through the CLI, discovers models, refreshes and removes only its own login', async () => {
    const { ctx, client, adapter, dir } = setup()
    expect(
      await adapter.availability(fromPartial({ rootDir: ctx.rootDir, env: ctx.env ?? {} })),
    ).toEqual({ available: true })
    const started = await adapter.authorize(ctx, {})
    if (started.state !== 'waiting-for-user') throw new Error('expected a browser challenge')
    expect(started.challenge).toMatchObject({
      kind: 'browser-code',
      verificationUrl: 'https://claude.com/cai/oauth/authorize?state=fixture',
    })
    expect(await adapter.refresh(ctx, started.challenge)).toEqual({ state: 'waiting-for-user' })
    expect(
      await adapter.authorize(ctx, {
        authorizationCode: 'authorized',
        loginId: started.challenge.loginId,
      }),
    ).toMatchObject({ state: 'connected', account: { label: 'fixture@example.test' } })
    expect(await adapter.catalog(ctx)).toEqual([
      { id: 'claude-test-model', label: 'Default', isDefault: true, routable: true },
      { id: 'claude-second-model', label: 'Sonnet', isDefault: false, routable: true },
    ])
    expect(await adapter.refresh(ctx)).toMatchObject({ state: 'connected' })
    await adapter.verify(ctx, 'claude-test-model')
    expect(ctx.probe).toHaveBeenCalledWith('claude-test-model')
    await adapter.revoke(ctx)
    expect(existsSync(dir)).toBe(false)
    await expect(client.status(ctx)).rejects.toMatchObject({ code: 'rejected' })
  })

  it('returns one allowed Veduta tool request and replays its result without ambient credentials or native tools', async () => {
    const { ctx, adapter, dir } = setup()
    expect(await collect(adapter.primaryInference.stream(ctx, request))).toEqual([
      {
        type: 'tool-call',
        toolCallId: expect.any(String),
        toolName: 'create_surface',
        input: { title: 'Claude Surface' },
      },
    ])
    const followup = {
      ...request,
      prompt: {
        ...request.prompt,
        messages: [
          ...request.prompt.messages,
          {
            role: 'tool' as const,
            toolCallId: 'previous-call',
            toolName: 'create_surface',
            text: 'Surface committed',
            isError: false,
          },
        ],
      },
    }
    expect(await collect(adapter.primaryInference.stream(ctx, followup))).toEqual([
      { type: 'text-delta', text: 'Claude completed the request.' },
    ])
    const launch = JSON.parse(readFileSync(join(dir, 'fixture-launch.json'), 'utf8'))
    expect(launch.ambientCredentials).toBe(false)
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--tools',
        '',
        '--safe-mode',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--permission-mode',
        'dontAsk',
      ]),
    )
    expect(launch.args.join(' ')).not.toContain('Create a Surface')
    expect(launch.cwd).toBe(realpathSync(join(dir, 'runtime')))
  })

  for (const [scenario, code] of [
    ['native-tool', 'unsupported'],
    ['oversized', 'unsupported'],
    ['rate-limit', 'rate-limit'],
    ['expired', 'expired'],
    ['formatting-limit', 'unsupported'],
    ['network', 'unreachable'],
  ] as const) {
    it(`refuses ${scenario} output without handing any tool request to Veduta`, async () => {
      const { ctx, adapter, dir, client } = setup()
      await client.checkVersion(ctx)
      writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ scenario }))
      await expect(collect(adapter.primaryInference.stream(ctx, request))).rejects.toMatchObject({
        code,
      })
    })
  }

  it('rejects invalid or unadvertised tool calls before yielding text or effects', async () => {
    const { ctx, client, adapter, dir } = setup()
    await client.checkVersion(ctx)
    for (const toolCall of [
      { name: 'Bash', inputJson: '{}' },
      { name: 'create_surface', inputJson: '[]' },
      { name: 'create_surface', inputJson: 'invalid' },
    ]) {
      writeFileSync(
        join(dir, 'fixture.json'),
        JSON.stringify({ output: { text: 'An effect happened', toolCall } }),
      )
      await expect(collect(adapter.primaryInference.stream(ctx, request))).rejects.toMatchObject({
        code: 'unsupported',
      })
    }
  })

  it('cancels a running CLI and refuses version drift', async () => {
    const { ctx, client, adapter, dir } = setup()
    await client.checkVersion(ctx)
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ scenario: 'hang' }))
    const abort = new AbortController()
    const result = collect(
      adapter.primaryInference.stream(ctx, { ...request, signal: abort.signal }),
    )
    setTimeout(() => abort.abort(), 60)
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ version: '0.0.0' }))
    await expect(client.checkVersion(ctx)).rejects.toMatchObject({ code: 'unsupported' })
  })
})

it('keeps an existing account reauthorization pending until this attempt completes', async () => {
  const { ctx, client, adapter } = setup()
  const initial = await adapter.authorize(ctx, {})
  if (initial.state !== 'waiting-for-user') throw new Error('missing challenge')
  await adapter.authorize(ctx, {
    authorizationCode: 'authorized',
    loginId: initial.challenge.loginId,
  })
  const replacement = await adapter.authorize(ctx, {})
  if (replacement.state !== 'waiting-for-user') throw new Error('missing replacement challenge')
  expect(await client.status(ctx, replacement.challenge.loginId)).toEqual({
    state: 'waiting-for-user',
  })
  await adapter.authorize(ctx, {
    authorizationCode: 'authorized',
    loginId: replacement.challenge.loginId,
  })
  expect(await client.status(ctx)).toMatchObject({ state: 'connected' })
})

it('rejects child acquisition that overlaps shutdown', async () => {
  const { ctx, client } = setup()
  const login = client.login(ctx)
  const failed = expect(login).rejects.toMatchObject({ code: 'rejected' })
  await client.close()
  await failed
})

it('refuses to erase a configuration behind a linked parent directory', async () => {
  const { ctx, client } = setup()
  const external = mkdtempSync(join(tmpdir(), 'veduta-claude-unrelated-'))
  roots.push(external)
  mkdirSync(join(external, ctx.connectionId))
  const unrelated = join(external, ctx.connectionId, 'keep.txt')
  writeFileSync(unrelated, 'preserve this')
  symlinkSync(external, join(ctx.rootDir, 'claude'), 'dir')
  await expect(client.remove(ctx)).rejects.toMatchObject({ code: 'unsupported' })
  expect(readFileSync(unrelated, 'utf8')).toBe('preserve this')
})

it('accepts a polling refresh that was already in flight when code completion finished', async () => {
  const { ctx, adapter } = setup()
  const started = await adapter.authorize(ctx, {})
  if (started.state !== 'waiting-for-user') throw new Error('missing challenge')
  await adapter.authorize(ctx, {
    authorizationCode: 'authorized',
    loginId: started.challenge.loginId,
  })
  expect(await adapter.refresh(ctx, started.challenge)).toMatchObject({ state: 'connected' })
})
