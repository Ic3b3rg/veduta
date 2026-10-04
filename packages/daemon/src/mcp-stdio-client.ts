import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { GithubMcpEgressProxy } from './github-mcp-egress.ts'
import { GITHUB_MCP_SCHEMAS, type GithubMcpMode } from './github-mcp-review.ts'

const MODERN = '2026-07-28'
const LEGACY = '2025-11-25'
const MAX_FRAME_BYTES = 1024 * 1024
const MAX_RESULT_BYTES = 64 * 1024
const MAX_TOOLS = 32

const Envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number().int().optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).passthrough().optional(),
  method: z.string().optional(),
})
const Tool = z.object({
  name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  description: z.string().max(2048).optional(),
  inputSchema: z.object({ type: z.literal('object') }).passthrough(),
})
const ToolList = z.object({ tools: z.array(z.unknown()), nextCursor: z.string().optional() })
const Discover = z.object({
  supportedVersions: z.array(z.string()),
  capabilities: z.object({ tools: z.unknown() }).passthrough(),
})
const Initialize = z.object({
  protocolVersion: z.literal(LEGACY),
  capabilities: z.object({ tools: z.unknown() }).passthrough(),
})
const ToolResult = z.object({
  content: z.array(z.object({ type: z.literal('text'), text: z.string() }).strict()),
  isError: z.boolean().optional(),
  resultType: z.enum(['complete', 'input_required']).optional(),
})
const FileToolResult = z.object({
  content: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({
          type: z.literal('resource'),
          resource: z.object({
            uri: z.string().max(2048),
            text: z.string().optional(),
            blob: z.string().optional(),
            mimeType: z.string().optional(),
          }),
        }),
        z.object({ type: z.literal('resource_link'), uri: z.string().max(2048) }),
      ]),
    )
    .min(1)
    .max(3),
  isError: z.boolean().optional(),
  resultType: z.enum(['complete', 'input_required']).optional(),
})
export type GithubMcpFile = { kind: 'text'; text: string } | { kind: 'binary' | 'too_large' }

export class McpClientError extends Error {
  constructor(
    readonly kind:
      | 'unavailable'
      | 'unsupported'
      | 'schema_changed'
      | 'malformed'
      | 'timeout'
      | 'cancelled'
      | 'tool_failed',
    message: string,
  ) {
    super(message)
  }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

/** One supervised MCP stdio session exposing exactly one reviewed GitHub capability. */
export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined
  private proxy: GithubMcpEgressProxy | undefined
  private nextId = 1
  private pending = new Map<number, Pending>()
  private output = Buffer.alloc(0)
  private protocol: typeof MODERN | typeof LEGACY | undefined
  private toolSchemaHash: string | undefined
  private stopped = false

  constructor(
    private readonly options: {
      executable: string
      cwd: string
      token: string
      mode?: GithubMcpMode
      timeoutMs?: number
      launch?: (proxyPort: number) => { command: string; args: string[] }
    },
  ) {}

  async start(): Promise<void> {
    if (this.child) throw new McpClientError('unsupported', 'MCP client already started')
    if (this.options.launch) this.proxy = await GithubMcpEgressProxy.start(this.options.token)
    let launch: { command: string; args: string[] }
    try {
      launch = this.options.launch
        ? this.options.launch(this.proxy!.port)
        : { command: this.options.executable, args: [] }
    } catch (error) {
      await this.proxy?.close()
      this.proxy = undefined
      throw error
    }
    this.child = spawn(
      launch.command,
      [
        ...launch.args,
        'stdio',
        `--tools=${GITHUB_MCP_SCHEMAS[this.options.mode ?? 'read'].name}`,
        ...(this.options.mode === 'write' ? [] : ['--read-only']),
      ],
      {
        cwd: this.options.cwd,
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: this.proxy?.credential ?? this.options.token,
          TZ: 'UTC',
          ...(this.proxy
            ? {
                GITHUB_HOST: `http://127.0.0.1:${this.proxy.port}`,
              }
            : {}),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      },
    )
    this.child.stdout.on('data', (chunk: Buffer) => this.onOutput(chunk))
    this.child.stderr.on('data', () => {
      // Server diagnostics are untrusted and may contain account data. Trace receives safe errors.
    })
    this.child.on('error', () =>
      this.failAll(new McpClientError('unavailable', 'MCP process failed')),
    )
    this.child.on('exit', () =>
      this.failAll(new McpClientError('unavailable', 'MCP process exited')),
    )

    try {
      let discovered: unknown
      try {
        discovered = await this.request('server/discover', {}, MODERN, 2_000)
      } catch (error) {
        if (
          !(error instanceof McpClientError) ||
          (error.kind !== 'timeout' && error.kind !== 'tool_failed')
        )
          throw error
      }
      if (discovered !== undefined) {
        const result = Discover.safeParse(discovered)
        if (!result.success || !result.data.supportedVersions.includes(MODERN))
          throw new McpClientError('unsupported', 'MCP server lacks the reviewed protocol')
        this.protocol = MODERN
      } else {
        const initialized = Initialize.safeParse(
          await this.request('initialize', {
            protocolVersion: LEGACY,
            capabilities: {},
            clientInfo: { name: 'veduta', version: '0.0.0' },
          }),
        )
        if (!initialized.success)
          throw new McpClientError('unsupported', 'MCP server lacks the reviewed legacy protocol')
        this.protocol = LEGACY
        this.notify('notifications/initialized', {})
      }
      await this.discoverTools()
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async discoverTools(): Promise<{
    name: 'list_issues' | 'issue_write' | 'get_file_contents'
    schemaSha256: string
  }> {
    if (!this.protocol) throw new McpClientError('unavailable', 'MCP session is not ready')
    let cursor: string | undefined
    const seen = new Set<string>()
    const tools: z.infer<typeof Tool>[] = []
    for (let page = 0; page < 8; page += 1) {
      const response = ToolList.safeParse(
        await this.request('tools/list', cursor === undefined ? {} : { cursor }),
      )
      if (!response.success) throw new McpClientError('malformed', 'MCP tool discovery failed')
      for (const value of response.data.tools) {
        const parsed = Tool.safeParse(value)
        if (!parsed.success)
          throw new McpClientError('malformed', 'MCP tool definition is malformed')
        if (seen.has(parsed.data.name))
          throw new McpClientError('malformed', 'MCP tool names are duplicated')
        seen.add(parsed.data.name)
        tools.push(parsed.data)
        if (tools.length > MAX_TOOLS)
          throw new McpClientError('unsupported', 'MCP tool count exceeds the reviewed bound')
      }
      if (!response.data.nextCursor) break
      if (cursor === response.data.nextCursor)
        throw new McpClientError('malformed', 'MCP tool pagination did not advance')
      cursor = response.data.nextCursor
      if (page === 7) throw new McpClientError('unsupported', 'MCP tool pages exceed the bound')
    }
    const reviewed = GITHUB_MCP_SCHEMAS[this.options.mode ?? 'read']
    const requiredName = reviewed.name
    const tool = tools.find((candidate) => candidate.name === requiredName)
    if (!tool)
      throw new McpClientError('unsupported', `Required GitHub ${requiredName} tool is missing`)
    const hash = createHash('sha256').update(JSON.stringify(tool.inputSchema)).digest('hex')
    if (hash !== reviewed.hash)
      throw new McpClientError('schema_changed', `GitHub ${requiredName} schema changed`)
    this.toolSchemaHash = hash
    return { name: requiredName, schemaSha256: hash }
  }

  async listOpenIssues(
    owner: string,
    repo: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; schemaSha256: string }> {
    if (!this.protocol || !this.toolSchemaHash || (this.options.mode ?? 'read') !== 'read')
      throw new McpClientError('unavailable', 'MCP tool is not verified')
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo))
      throw new McpClientError('unsupported', 'Repository scope is invalid')
    const result = ToolResult.safeParse(
      await this.request(
        'tools/call',
        {
          name: 'list_issues',
          arguments: {
            owner,
            repo,
            state: 'OPEN',
            perPage: 10,
            fields: ['number', 'title', 'state', 'updated_at'],
          },
        },
        this.protocol,
        this.options.timeoutMs ?? 20_000,
        signal,
      ),
    )
    if (!result.success || result.data.resultType === 'input_required')
      throw new McpClientError('unsupported', 'MCP result needs an unsupported interaction')
    if (result.data.isError) throw new McpClientError('tool_failed', 'GitHub issue read failed')
    const text = result.data.content.map((part) => part.text).join('\n')
    if (Buffer.byteLength(text) > MAX_RESULT_BYTES)
      throw new McpClientError('malformed', 'MCP tool result exceeds the reviewed bound')
    return { text, schemaSha256: this.toolSchemaHash }
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string,
    signal?: AbortSignal,
  ): Promise<{ text: string; schemaSha256: string }> {
    if (!this.protocol || !this.toolSchemaHash || this.options.mode !== 'write')
      throw new McpClientError('unavailable', 'MCP write tool is not verified')
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo))
      throw new McpClientError('unsupported', 'Repository scope is invalid')
    if (!title.trim() || title.length > 240 || body.length > 10_000)
      throw new McpClientError('unsupported', 'Issue content exceeds the reviewed bound')
    const result = ToolResult.safeParse(
      await this.request(
        'tools/call',
        { name: 'issue_write', arguments: { method: 'create', owner, repo, title, body } },
        this.protocol,
        this.options.timeoutMs ?? 20_000,
        signal,
      ),
    )
    if (!result.success || result.data.resultType === 'input_required')
      throw new McpClientError('unsupported', 'MCP result needs an unsupported interaction')
    if (result.data.isError) throw new McpClientError('tool_failed', 'GitHub issue creation failed')
    const text = result.data.content.map((part) => part.text).join('\n')
    if (Buffer.byteLength(text) > MAX_RESULT_BYTES)
      throw new McpClientError('malformed', 'MCP tool result exceeds the reviewed bound')
    return { text, schemaSha256: this.toolSchemaHash }
  }

  async readFile(
    owner: string,
    repo: string,
    path: string,
    commitSha: string,
    signal?: AbortSignal,
  ): Promise<GithubMcpFile> {
    if (!this.protocol || !this.toolSchemaHash || this.options.mode !== 'files')
      throw new McpClientError('unavailable', 'MCP file tool is not verified')
    if (!/^[a-f0-9]{40}$/.test(commitSha))
      throw new McpClientError('unsupported', 'A pinned commit is required')
    const raw = await this.request(
      'tools/call',
      { name: 'get_file_contents', arguments: { owner, repo, path, sha: commitSha } },
      this.protocol,
      this.options.timeoutMs ?? 20_000,
      signal,
    )
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_RESULT_BYTES)
      throw new McpClientError('malformed', 'GitHub file exceeds the reviewed result limit')
    const result = FileToolResult.safeParse(raw)
    if (!result.success || result.data.resultType === 'input_required')
      throw new McpClientError('unsupported', 'GitHub returned unsupported file content')
    if (result.data.isError)
      throw new McpClientError(
        'tool_failed',
        'GitHub could not read this file. Check the path, revision and Contents permission.',
      )
    const resources = result.data.content.filter((part) => part.type === 'resource')
    if (resources.length === 1) {
      const resource = resources[0]!.resource
      if (resource.blob !== undefined) return { kind: 'binary' }
      if (resource.text !== undefined) return { kind: 'text', text: resource.text }
    }
    if (result.data.content.some((part) => part.type === 'resource_link'))
      return { kind: 'too_large' }
    throw new McpClientError('malformed', 'GitHub returned no verifiable file content')
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    this.child = undefined
    const closingProxy = this.proxy?.close()
    this.proxy = undefined
    this.failAll(new McpClientError('cancelled', 'MCP session stopped'))
    await closingProxy
    if (!child || child.exitCode !== null) return
    child.stdin.end()
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ])
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>((resolve) => child.once('exit', () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 500)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    version = this.protocol,
    timeoutMs = this.options.timeoutMs ?? 10_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.child || this.stopped)
      return Promise.reject(new McpClientError('unavailable', 'MCP process is unavailable'))
    const id = this.nextId++
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params: version === MODERN ? { ...params, _meta: modernMeta() } : params,
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        this.notify('notifications/cancelled', { requestId: id, reason: 'deadline exceeded' })
        reject(new McpClientError('timeout', 'MCP request timed out'))
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled by user' })
        reject(new McpClientError('cancelled', 'MCP request was cancelled'))
      }
      if (signal?.aborted) return onAbort()
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        ...(signal ? { removeAbort: () => signal.removeEventListener('abort', onAbort) } : {}),
      })
      this.child!.stdin.write(`${JSON.stringify(payload)}\n`)
    })
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.child || this.stopped) return
    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method, params: this.protocol === MODERN ? { ...params, _meta: modernMeta() } : params })}\n`,
    )
  }

  private onOutput(chunk: Buffer): void {
    this.output = Buffer.concat([this.output, chunk])
    if (this.output.length > MAX_FRAME_BYTES) {
      this.failAll(new McpClientError('malformed', 'MCP response frame exceeds the bound'))
      void this.stop()
      return
    }
    let newline = this.output.indexOf(10)
    while (newline !== -1) {
      const line = this.output.subarray(0, newline)
      this.output = this.output.subarray(newline + 1)
      try {
        const response = Envelope.parse(JSON.parse(line.toString('utf8')))
        if (response.id !== undefined) {
          const pending = this.pending.get(response.id)
          if (pending) {
            this.pending.delete(response.id)
            clearTimeout(pending.timer)
            pending.removeAbort?.()
            if (response.error)
              pending.reject(new McpClientError('tool_failed', 'MCP server rejected the request'))
            else pending.resolve(response.result)
          }
        } else if (response.method === 'notifications/tools/list_changed') {
          this.toolSchemaHash = undefined
        }
      } catch {
        this.failAll(new McpClientError('malformed', 'MCP server sent an invalid frame'))
        void this.stop()
        return
      }
      newline = this.output.indexOf(10)
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort?.()
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function modernMeta(): Record<string, unknown> {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'veduta', version: '0.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  }
}
