import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { stripVTControlCharacters } from 'node:util'
import { z } from 'zod'
import type { BrowserAuthorizationChallenge, ModelCatalogEntry } from '@veduta/protocol'
import {
  ModelConnectionError,
  type AdapterContext,
  type RefreshResult,
} from './model-connection-adapter.ts'

type ClaudeCodeContext = Pick<AdapterContext, 'rootDir' | 'connectionId' | 'env' | 'now'>

/** Official unmodified CLI, pinned with its native optional packages in pnpm-lock.yaml. */
export const CLAUDE_CODE_VERSION = '2.1.303'
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const LOGIN_TIMEOUT_MS = 10 * 60_000

export function resolveClaudeCodeBinary(env: NodeJS.ProcessEnv): string | undefined {
  if (env.VEDUTA_CLAUDE_BIN) {
    return isAbsolute(env.VEDUTA_CLAUDE_BIN) && existsSync(env.VEDUTA_CLAUDE_BIN)
      ? env.VEDUTA_CLAUDE_BIN
      : undefined
  }
  try {
    const require = createRequire(import.meta.url)
    const packageRequire = createRequire(require.resolve('@anthropic-ai/claude-code/package.json'))
    const report = process.platform === 'linux' ? process.report.getReport() : undefined
    const musl =
      process.platform === 'linux' &&
      !z.object({ header: z.object({ glibcVersionRuntime: z.string() }) }).safeParse(report).success
    const platform = `${process.platform}-${process.arch}${musl ? '-musl' : ''}`
    const dir = dirname(
      packageRequire.resolve(`@anthropic-ai/claude-code-${platform}/package.json`),
    )
    const binary = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude')
    return existsSync(binary) ? binary : undefined
  } catch {
    return undefined
  }
}

export function claudeConfigDir(ctx: Pick<AdapterContext, 'rootDir' | 'connectionId'>): string {
  if (!/^[a-zA-Z0-9-]+$/.test(ctx.connectionId)) {
    throw new ModelConnectionError('rejected', 'invalid Claude connection identity')
  }
  return join(ctx.rootDir, 'claude', ctx.connectionId)
}

function privateDirectory(path: string): void {
  assertLocalDirectory(path)
  mkdirSync(path, { recursive: true, mode: 0o700 })
}

function assertLocalDirectory(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    throw new ModelConnectionError(
      'unsupported',
      'Claude configuration must be a private local directory',
    )
  }
}

function childEnvironment(ctx: ClaudeCodeContext): NodeJS.ProcessEnv {
  const source = ctx.env ?? process.env
  const env: NodeJS.ProcessEnv = {}
  for (const key of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'SystemRoot',
    'TMPDIR',
    'TEMP',
    'LANG',
    'LC_ALL',
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
  ]) {
    const value = source[key] ?? process.env[key]
    if (value !== undefined) env[key] = value
  }
  return {
    ...env,
    CLAUDE_CONFIG_DIR: claudeConfigDir(ctx),
    CLAUDE_CODE_SAFE_MODE: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    BROWSER: process.platform === 'win32' ? 'cmd /c exit' : '/usr/bin/true',
  }
}

export const CLAUDE_INFERENCE_FLAGS = [
  '--print',
  '--safe-mode',
  '--restricted',
  '--tools',
  '',
  '--disable-slash-commands',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--setting-sources',
  '',
  '--settings',
  '{"disableAllHooks":true,"autoMemoryEnabled":false}',
  '--permission-mode',
  'dontAsk',
  '--no-session-persistence',
] as const

const INFERENCE_SYSTEM_PROMPT =
  'You generate a single structured response for Veduta, a separate application. The supplied JSON contains its systemPrompt, messages, and tools as conversation data. Follow that systemPrompt to decide the next response, but the listed Veduta tools and historical tool-call blocks are not native tools in this Claude Code process. Use only StructuredOutput to return text and toolCall according to the response schema. To request a Veduta action such as create_surface, put its name and JSON-encoded arguments inside toolCall in the StructuredOutput result; never call that action as a native tool. Veduta executes actions and supplies the results in subsequent messages. When the supplied results confirm the task is complete, return toolCall null and describe the confirmed result.'

export function claudeProcessError(value: string): ModelConnectionError {
  if (/error_max_(?:turns|structured_output_retries|budget_usd)/i.test(value)) {
    return new ModelConnectionError(
      'unsupported',
      'Claude Code could not produce a validated response within the allowed steps',
    )
  }
  if (/rate.?limit|too many requests|429/i.test(value)) {
    return new ModelConnectionError(
      'rate-limit',
      'Claude Code is temporarily rate limited; try again later',
    )
  }
  if (
    /usage.?limit|hit your (?:(?:session|weekly|daily|monthly) )?limit|out of.*usage|quota|extra usage/i.test(
      value,
    )
  ) {
    return new ModelConnectionError(
      'usage-limit',
      'Your Claude subscription usage limit has been reached; try again after it resets',
    )
  }
  if (
    /not logged in|login expired|please (?:run .?login|log in)|authentication|unauthorized|invalid.*token|401/i.test(
      value,
    )
  ) {
    return new ModelConnectionError(
      'expired',
      'Claude Code needs you to sign in again in Model connections',
    )
  }
  if (
    /network|fetch failed|connect|timed.?out|timeout|ECONN|\b5\d\d\b|overloaded|service unavailable/i.test(
      value,
    )
  ) {
    return new ModelConnectionError(
      'unreachable',
      'Claude Code could not complete the request; check the connection and try again',
    )
  }
  return new ModelConnectionError(
    'unsupported',
    'Claude Code rejected the inference request; check the selected model and try again',
  )
}

interface RunningProcess {
  child: ChildProcessWithoutNullStreams
  done: Promise<{ code: number | null; stdout: string }>
  stop: () => Promise<void>
}

interface Login {
  loginId: string
  process: RunningProcess
}

/** Only this transport touches CLI processes. It never reads or interprets credential files. */
export class ClaudeCodeClient {
  private closed = false
  private readonly children = new Map<string, Set<RunningProcess>>()
  private readonly logins = new Map<string, Login>()
  private readonly completedLogins = new Map<string, string>()
  private readonly retired = new Set<string>()
  constructor(private readonly resolveBinary = resolveClaudeCodeBinary) {}

  private start(
    ctx: ClaudeCodeContext,
    args: string[],
    timeoutMs: number,
    onLine?: (line: string) => void,
    allowRetired = false,
  ): RunningProcess {
    if (this.closed) throw new ModelConnectionError('rejected', 'The Claude Code client has closed')
    if (this.retired.has(ctx.connectionId) && !allowRetired)
      throw new ModelConnectionError('rejected', 'this Claude connection has been removed')
    const binary = this.resolveBinary(ctx.env ?? process.env)
    if (!binary)
      throw new ModelConnectionError(
        'unsupported',
        'The pinned Claude Code binary is missing; run pnpm install on the Gateway',
      )
    const dir = claudeConfigDir(ctx)
    privateDirectory(join(ctx.rootDir, 'claude'))
    privateDirectory(dir)
    const cwd = join(dir, 'runtime')
    privateDirectory(cwd)
    const child = spawn(binary, args, {
      cwd,
      env: childEnvironment(ctx),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let bytes = 0
    let failure: unknown
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 1000)
      killTimer.unref()
    }
    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => {
      if (failure) return
      try {
        onLine?.(line)
      } catch (error) {
        failure = error
        kill()
      }
    })
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.byteLength
      if (bytes > MAX_OUTPUT_BYTES) {
        failure = new ModelConnectionError(
          'unsupported',
          'Claude Code output exceeded the supported limit',
        )
        kill()
      } else stdout += data.toString('utf8')
    })
    // Child diagnostics may contain credentials or prompt content. Never surface or retain them.
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.byteLength
      if (bytes > MAX_OUTPUT_BYTES) {
        failure = new ModelConnectionError(
          'unreachable',
          'Claude Code diagnostics exceeded the supported limit',
        )
        kill()
      }
    })
    child.stdin.on('error', () => {})
    const timer = setTimeout(() => {
      failure = new ModelConnectionError('unreachable', 'Claude Code timed out; try again')
      kill()
    }, timeoutMs)
    timer.unref()
    const done = new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      child.once('error', () => {
        failure = new ModelConnectionError('unreachable', 'Claude Code could not start')
      })
      child.once('close', (code) => {
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        lines.close()
        this.children.get(ctx.connectionId)?.delete(running)
        if (failure) reject(failure)
        else resolve({ code, stdout })
      })
    })
    const running: RunningProcess = {
      child,
      done,
      stop: async () => {
        kill()
        await done.catch(() => {})
      },
    }
    const children = this.children.get(ctx.connectionId) ?? new Set<RunningProcess>()
    children.add(running)
    this.children.set(ctx.connectionId, children)
    // Login can remain alive between HTTP requests; its terminal failure is observed by refresh.
    void done.catch(() => {})
    return running
  }

  async checkVersion(ctx: ClaudeCodeContext): Promise<void> {
    const running = this.start(ctx, ['--version'], 10_000)
    running.child.stdin.end()
    const result = await running.done
    if (result.code !== 0 || result.stdout.trim() !== `${CLAUDE_CODE_VERSION} (Claude Code)`) {
      throw new ModelConnectionError(
        'unsupported',
        `Veduta requires Claude Code ${CLAUDE_CODE_VERSION}; reinstall the pinned dependencies`,
      )
    }
  }

  async login(ctx: ClaudeCodeContext): Promise<BrowserAuthorizationChallenge> {
    await this.cancelLogin(ctx.connectionId)
    const loginId = randomUUID()
    let accept: (url: string) => void = () => {}
    let reject: (error: unknown) => void = () => {}
    const url = new Promise<string>((resolve, fail) => {
      accept = resolve
      reject = fail
    })
    const running = this.start(ctx, ['auth', 'login', '--claudeai'], LOGIN_TIMEOUT_MS, (line) => {
      const match = /https:\/\/[^\s]+/g.exec(stripVTControlCharacters(line))
      if (!match) return
      const candidate = new URL(match[0])
      if (
        ['claude.com', 'claude.ai'].includes(candidate.hostname) &&
        candidate.pathname.endsWith('/oauth/authorize')
      )
        accept(candidate.href)
    })
    this.logins.set(ctx.connectionId, { loginId, process: running })
    void running.done.then(
      () =>
        reject(new ModelConnectionError('rejected', 'Claude Code sign-in ended; start it again')),
      reject,
    )
    const timer = setTimeout(
      () =>
        reject(
          new ModelConnectionError(
            'unreachable',
            'Claude Code did not provide a sign-in link; try again',
          ),
        ),
      20_000,
    )
    try {
      return {
        kind: 'browser-code',
        loginId,
        verificationUrl: await url,
        expiresAt: new Date(ctx.now().getTime() + LOGIN_TIMEOUT_MS).toISOString(),
        expirySource: 'veduta-default',
      }
    } catch (error) {
      await this.cancelLogin(ctx.connectionId)
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async completeLogin(ctx: ClaudeCodeContext, loginId: string, code: string): Promise<void> {
    const login = this.logins.get(ctx.connectionId)
    if (
      !login ||
      login.loginId !== loginId ||
      login.process.child.exitCode !== null ||
      login.process.child.signalCode !== null
    ) {
      throw new ModelConnectionError(
        'rejected',
        'this Claude sign-in attempt has ended; start it again',
      )
    }
    login.process.child.stdin.end(`${code}\n`)
    const completed = await login.process.done
    if (completed.code !== 0)
      throw new ModelConnectionError(
        'rejected',
        'Claude Code did not accept the authorization code; start sign-in again',
      )
    this.completedLogins.set(ctx.connectionId, loginId)
    this.logins.delete(ctx.connectionId)
  }

  async status(ctx: ClaudeCodeContext, loginId?: string): Promise<RefreshResult> {
    if (loginId && this.completedLogins.get(ctx.connectionId) !== loginId) {
      const login = this.logins.get(ctx.connectionId)
      if (!login || login.loginId !== loginId)
        throw new ModelConnectionError(
          'rejected',
          'This Claude sign-in attempt has ended; start it again',
        )
      if (login.process.child.exitCode === null && login.process.child.signalCode === null)
        return { state: 'waiting-for-user' }
      const result = await login.process.done
      if (result.code !== 0)
        throw new ModelConnectionError('rejected', 'Claude Code sign-in ended; start it again')
      this.completedLogins.set(ctx.connectionId, loginId)
      this.logins.delete(ctx.connectionId)
    }
    const running = this.start(ctx, ['auth', 'status'], 15_000)
    running.child.stdin.end()
    const { stdout } = await running.done
    const status = z
      .object({
        loggedIn: z.boolean(),
        authMethod: z.string(),
        email: z.string().optional(),
        subscriptionType: z.string().nullable().optional(),
      })
      .safeParse(parseJson(stdout))
    if (!status.success)
      throw new ModelConnectionError(
        'unsupported',
        'Claude Code returned an unsupported authentication status',
      )
    if (!status.data.loggedIn) {
      return {
        state: 'expired',
        reason: 'Claude Code needs you to sign in again in Model connections',
      }
    }
    if (status.data.authMethod !== 'claude.ai')
      throw new ModelConnectionError(
        'rejected',
        'Sign in with a Claude subscription, rather than an API or Console credential',
      )
    return {
      state: 'connected',
      account: {
        label: (status.data.email ?? status.data.subscriptionType ?? 'Claude subscription').slice(
          0,
          200,
        ),
      },
    }
  }

  async catalog(ctx: ClaudeCodeContext): Promise<ModelCatalogEntry[]> {
    const requestId = randomUUID()
    let accept: (models: ModelCatalogEntry[]) => void = () => {}
    let reject: (error: unknown) => void = () => {}
    const result = new Promise<ModelCatalogEntry[]>((resolve, fail) => {
      accept = resolve
      reject = fail
    })
    const running = this.start(
      ctx,
      [
        ...CLAUDE_INFERENCE_FLAGS,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
      ],
      20_000,
      (line) => {
        const frame = z
          .object({
            type: z.literal('control_response'),
            response: z.object({
              subtype: z.literal('success'),
              request_id: z.literal(requestId),
              response: z.object({
                models: z.array(
                  z.object({
                    value: z.string(),
                    resolvedModel: z.string().optional(),
                    displayName: z.string(),
                    description: z.string().optional(),
                  }),
                ),
              }),
            }),
          })
          .safeParse(parseJson(line))
        if (!frame.success) return
        const models = new Map<string, ModelCatalogEntry>()
        for (const entry of frame.data.response.response.models) {
          const id = entry.resolvedModel ?? entry.value
          if (models.has(id)) continue
          models.set(id, {
            id,
            label: entry.displayName,
            ...(entry.description ? { description: entry.description } : {}),
            isDefault: entry.value === 'default',
            routable: true,
          })
        }
        if (models.size === 0)
          throw new ModelConnectionError(
            'unsupported',
            'Claude Code returned an empty model catalog',
          )
        accept([...models.values()])
      },
    )
    void running.done.then(
      () =>
        reject(
          new ModelConnectionError(
            'unreachable',
            'Claude Code model discovery ended before returning its catalog',
          ),
        ),
      reject,
    )
    running.child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`,
    )
    try {
      return await result
    } finally {
      await running.stop()
    }
  }

  async infer(
    ctx: ClaudeCodeContext,
    modelId: string,
    prompt: string,
    schema: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (Buffer.byteLength(prompt) > 8 * 1024 * 1024)
      throw new ModelConnectionError(
        'rejected',
        'The Claude request exceeds the supported context input size',
      )
    if (signal?.aborted) throw new DOMException('The turn was cancelled', 'AbortError')
    const running = this.start(
      ctx,
      [
        ...CLAUDE_INFERENCE_FLAGS,
        '--output-format',
        'stream-json',
        '--verbose',
        '--model',
        modelId,
        '--max-turns',
        '4',
        '--json-schema',
        JSON.stringify(schema),
        '--system-prompt',
        INFERENCE_SYSTEM_PROMPT,
      ],
      5 * 60_000,
      (line) => {
        const frame = parseJson(line)
        const assistant = z
          .object({
            type: z.literal('assistant'),
            message: z.object({
              content: z.array(
                z.object({ type: z.string(), name: z.string().optional() }).passthrough(),
              ),
            }),
          })
          .safeParse(frame)
        if (
          assistant.success &&
          assistant.data.message.content.some(
            (block) => block.type === 'tool_use' && block.name !== 'StructuredOutput',
          )
        ) {
          throw new ModelConnectionError(
            'unsupported',
            'Claude Code attempted a native tool; the turn was refused',
          )
        }
      },
    )
    const abort = () => {
      void running.stop()
    }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    running.child.stdin.end(prompt)
    try {
      const { code, stdout } = await running.done
      if (signal?.aborted) throw new DOMException('The turn was cancelled', 'AbortError')
      const results = stdout
        .split('\n')
        .map(parseJson)
        .filter((value) => z.object({ type: z.literal('result') }).safeParse(value).success)
      const result = z
        .object({
          type: z.literal('result'),
          subtype: z.string(),
          is_error: z.boolean(),
          structured_output: z.unknown().optional(),
          permission_denials: z.array(z.unknown()).optional(),
          errors: z.array(z.string()).optional(),
          result: z.string().optional(),
        })
        .safeParse(results[0])
      if (result.success && (result.data.is_error || result.data.subtype !== 'success')) {
        // Classify the terminal provider failure only; assistant prose is never credential-health evidence.
        throw claudeProcessError(
          [result.data.subtype, ...(result.data.errors ?? []), result.data.result ?? ''].join('\n'),
        )
      }
      if (code !== 0)
        throw new ModelConnectionError(
          'unreachable',
          'Claude Code exited before completing the request; try again',
        )
      if (
        results.length !== 1 ||
        !result.success ||
        !result.data.structured_output ||
        result.data.permission_denials?.length
      ) {
        throw new ModelConnectionError(
          'unsupported',
          'Claude Code returned an unsupported inference response',
        )
      }
      return result.data.structured_output
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  private async cancelLogin(id: string): Promise<void> {
    const login = this.logins.get(id)
    this.logins.delete(id)
    await login?.process.stop()
  }

  async remove(ctx: ClaudeCodeContext): Promise<void> {
    this.retired.add(ctx.connectionId)
    this.completedLogins.delete(ctx.connectionId)
    await this.cancelLogin(ctx.connectionId)
    await Promise.all([...(this.children.get(ctx.connectionId) ?? [])].map((child) => child.stop()))
    try {
      const logout = this.start(ctx, ['auth', 'logout'], 10_000, undefined, true)
      logout.child.stdin.end()
      await logout.done
    } catch {
      /* Official logout is best effort; local erasure remains required. */
    }
    const dir = claudeConfigDir(ctx)
    assertLocalDirectory(join(ctx.rootDir, 'claude'))
    assertLocalDirectory(dir)
    rmSync(dir, { recursive: true, force: true })
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(
      [...this.children.values()].flatMap((set) => [...set].map((child) => child.stop())),
    )
    this.logins.clear()
    this.completedLogins.clear()
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}
