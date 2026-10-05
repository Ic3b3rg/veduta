import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  type ConnectionReview,
  type ServiceConnection,
  type SpaceCapabilityGrant,
} from '@veduta/protocol'
import { installReviewedGithubMcp, reviewedGithubMcpArtifact } from './github-mcp-artifact.ts'
import { McpClientError, McpStdioClient } from './mcp-stdio-client.ts'
import { reviewedGithubMcpLaunch } from './reviewed-github-mcp-launch.ts'
import { defaultRedactor } from './redaction.ts'
import { GithubMcpEffects } from './github-mcp-effects.ts'
import {
  ServiceConnectionError,
  githubRepositoryAllowed,
  type ServiceConnections,
} from './service-connections.ts'
import type { SecretsVault } from './secrets-vault.ts'
import {
  GITHUB_MCP_SCHEMAS,
  GITHUB_READ_PROFILE_HASH,
  type GithubMcpMode,
} from './github-mcp-review.ts'
import { GithubApiReadError, readGithubJson } from './github-api-read.ts'
import { readGithubPath, type GithubRevision } from './github-file-read.ts'

const SOURCE = 'https://github.com/github/github-mcp-server/releases/tag/v1.12.2'
const Profile = z.object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/) })

export type GithubMcpSession = Pick<
  McpStdioClient,
  'start' | 'discoverTools' | 'listOpenIssues' | 'createIssue' | 'stop'
> &
  Partial<Pick<McpStdioClient, 'readFile'>>

export function githubConnectionReview(
  owner: string,
  name: string,
  accountHint?: string,
  mode: 'read' | 'write' = 'read',
): ConnectionReview {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(name))
    throw new ServiceConnectionError(400, 'Repository scope is invalid')
  const artifact = reviewedGithubMcpArtifact()
  return {
    service: 'github',
    ...(accountHint ? { accountHint } : {}),
    scopes: [`GitHub Issues: ${mode} in ${owner}/${name}`],
    actions: [mode === 'write' ? 'issue_write' : 'list_issues'],
    executionHost: `Gateway local stdio (${process.platform}/${process.arch})`,
    serverVersion: 'v1.12.2',
    serverSource: SOURCE,
    archiveSha256: artifact.archiveSha256,
    executableSha256: artifact.executableSha256,
    toolSchemaSha256: GITHUB_MCP_SCHEMAS[mode].hash,
    repository: { owner, name },
  }
}

export function githubReadConnectionReview(accountHint?: string): ConnectionReview {
  const { repository: _repository, ...base } = githubConnectionReview(
    'review',
    'profile',
    accountHint,
  )
  return {
    ...base,
    scopes: ['GitHub Metadata: read', 'GitHub Contents: read', 'GitHub Issues: read'],
    actions: ['list_repositories', 'list_issues', 'read_files'],
    repositoryScope: { mode: 'authorized' },
    toolSchemaSha256: GITHUB_READ_PROFILE_HASH,
  }
}

export class GithubMcpService {
  private readonly effects: GithubMcpEffects
  private readonly active = new Map<
    AbortController,
    {
      spaceId: string
      connectionId: string
      grantId: string
      action: 'list_issues' | 'issue_write' | 'list_repositories' | 'read_files'
      repository?: { owner: string; name: string }
    }
  >()
  private readonly dispose: () => void

  constructor(
    private readonly options: {
      rootDir: string
      connections: ServiceConnections
      vault: SecretsVault | undefined
      fetchFn?: typeof fetch
      install?: typeof installReviewedGithubMcp
      createClient?: (input: {
        executable: string
        cwd: string
        token: string
        mode: GithubMcpMode
      }) => GithubMcpSession
    },
  ) {
    this.effects = new GithubMcpEffects(options.rootDir)
    this.dispose = options.connections.onChange(() => this.cancelRevokedCalls())
  }

  async verifyAttempt(attemptId: string, token: string): Promise<void> {
    const attempt = this.options.connections.attempt(attemptId)
    if (!attempt || attempt.review.service !== 'github')
      throw new ServiceConnectionError(404, 'GitHub Connection attempt not found')
    if (!this.options.vault) throw new ServiceConnectionError(409, 'Secrets vault is unavailable')
    if (!/^github_pat_[A-Za-z0-9_]{20,}$/.test(token))
      throw new ServiceConnectionError(400, 'A fine-grained GitHub token is required')
    defaultRedactor.register(token)
    this.options.connections.beginVerification(attemptId)
    const credentialRef = `secret://vault/github-mcp-${randomUUID()}`
    try {
      if (process.platform !== 'darwin' && !this.options.createClient)
        throw new McpClientError(
          'unsupported',
          'This host has no verified GitHub MCP process boundary',
        )
      const account = await this.verifyAccount(token)
      const executable = await (this.options.install ?? installReviewedGithubMcp)(
        this.options.rootDir,
      )
      const modes: GithubMcpMode[] = attempt.review.repositoryScope
        ? ['read', 'files']
        : [attempt.review.actions.includes('issue_write') ? 'write' : 'read']
      if (
        attempt.review.repositoryScope &&
        attempt.review.toolSchemaSha256 !== GITHUB_READ_PROFILE_HASH
      )
        throw new Error('Required GitHub read profile changed')
      for (const mode of modes) {
        const client = this.client(executable, token, mode)
        try {
          await client.start()
          const tool = await client.discoverTools()
          const reviewed = GITHUB_MCP_SCHEMAS[mode]
          if (tool.name !== reviewed.name || tool.schemaSha256 !== reviewed.hash)
            throw new Error('Required GitHub tool schema changed')
        } finally {
          await client.stop()
        }
      }
      this.options.vault.set(credentialRef.slice('secret://vault/'.length), token)
      this.options.connections.verified(attemptId, {
        connectionId: attempt.connectionId ?? `svc-github-${randomUUID()}`,
        account,
        scopes: attempt.review.scopes,
        mechanism: 'github-mcp-stdio',
        credentialRef,
      })
    } catch (error) {
      this.options.vault.delete(credentialRef.slice('secret://vault/'.length))
      if (this.options.connections.attempt(attemptId)?.state === 'verifying')
        this.options.connections.fail(
          attemptId,
          (error instanceof McpClientError &&
            (error.kind === 'schema_changed' || error.kind === 'unsupported')) ||
            (error instanceof Error && error.message.includes('process boundary'))
            ? 'unsupported'
            : 'failed',
          error instanceof McpClientError && error.kind === 'schema_changed'
            ? 'Required GitHub MCP capability changed; review the server again.'
            : error instanceof Error && error.message.includes('process boundary')
              ? 'This host cannot isolate the reviewed GitHub MCP process.'
              : 'GitHub verification failed; check the token, server, and network, then retry.',
        )
      throw error instanceof ServiceConnectionError
        ? error
        : new ServiceConnectionError(502, 'GitHub verification failed')
    }
  }

  async listRepositories(input: {
    spaceId: string
    accountHint?: string
    connectionId?: string
    owner?: string
    page?: number
    signal?: AbortSignal
  }) {
    const page = input.page ?? 1
    if (!Number.isInteger(page) || page < 1 || page > 5)
      throw new ServiceConnectionError(
        400,
        'Repository discovery is limited to five pages per request',
      )
    return this.authorizedRead(
      { ...input, action: 'list_repositories' },
      async (token, signal, grant) => {
        const response = await readGithubJson(
          token,
          `/user/repos?per_page=20&page=${page}&sort=full_name&direction=asc`,
          this.options.fetchFn ?? fetch,
          signal,
        )
        const repositories = z
          .array(
            z.object({
              name: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
              owner: z.object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/) }),
              private: z.boolean(),
            }),
          )
          .max(20)
          .parse(response.data)
          .filter(
            (repo) =>
              (!input.owner || repo.owner.login.toLowerCase() === input.owner.toLowerCase()) &&
              githubRepositoryAllowed(grant, { owner: repo.owner.login, name: repo.name }),
          )
          .map((repo) => ({
            owner: repo.owner.login,
            name: repo.name,
            private: repo.private,
            url: `https://github.com/${repo.owner.login}/${repo.name}`,
          }))
        return { repositories, hasMore: response.hasMore, page }
      },
    )
  }

  async readFile(input: {
    spaceId: string
    accountHint?: string
    connectionId?: string
    repository: { owner: string; name: string }
    path: string
    ref?: string
    revision?: GithubRevision
    signal?: AbortSignal
  }) {
    return this.authorizedRead({ ...input, action: 'read_files' }, (token, signal) =>
      readGithubPath({
        token,
        owner: input.repository.owner,
        repo: input.repository.name,
        path: input.path,
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.revision ? { revision: input.revision } : {}),
        fetchFn: this.options.fetchFn ?? fetch,
        signal,
        readFile: async (path, commit) => {
          const executable = await (this.options.install ?? installReviewedGithubMcp)(
            this.options.rootDir,
            { signal },
          )
          const client = this.client(executable, token, 'files')
          try {
            await client.start()
            const tool = await client.discoverTools()
            if (
              tool.name !== GITHUB_MCP_SCHEMAS.files.name ||
              tool.schemaSha256 !== GITHUB_MCP_SCHEMAS.files.hash ||
              !client.readFile
            )
              throw new McpClientError(
                'schema_changed',
                'The reviewed GitHub file capability is unavailable',
              )
            signal.throwIfAborted()
            return await client.readFile(
              input.repository.owner,
              input.repository.name,
              path,
              commit,
              signal,
            )
          } finally {
            await client.stop()
          }
        },
      }),
    )
  }

  private async authorizedRead<T>(
    input: {
      spaceId: string
      action: 'list_repositories' | 'read_files'
      accountHint?: string
      connectionId?: string
      repository?: { owner: string; name: string }
      signal?: AbortSignal
    },
    run: (token: string, signal: AbortSignal, grant: SpaceCapabilityGrant) => Promise<T>,
  ) {
    const query = {
      spaceId: input.spaceId,
      service: 'github' as const,
      action: input.action,
      ...(input.accountHint ? { accountHint: input.accountHint } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      ...(input.repository ? { repository: input.repository } : {}),
    }
    const eligible = this.options.connections.eligible(query)
    if (!eligible?.credentialRef || !this.options.vault)
      throw new ServiceConnectionError(
        403,
        'GitHub read access is not granted for this Space and repository. Review Service connections.',
      )
    const token = this.options.vault.resolve(eligible.credentialRef)
    if (!token) throw new ServiceConnectionError(409, 'GitHub connection needs reconnection')
    const controller = new AbortController()
    const abort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener('abort', abort, { once: true })
    this.active.set(controller, {
      ...query,
      connectionId: eligible.connection.id,
      grantId: eligible.grant.id,
    })
    try {
      controller.signal.throwIfAborted()
      const result = await run(token, controller.signal, eligible.grant)
      controller.signal.throwIfAborted()
      const current = this.options.connections.eligible({
        ...query,
        connectionId: eligible.connection.id,
      })
      if (current?.grant.id !== eligible.grant.id)
        throw new ServiceConnectionError(403, 'GitHub Space access changed during the read')
      return {
        ...result,
        connection: current.connection,
        grant: current.grant,
        origin: `untrusted:github-mcp-${current.connection.id}` as const,
      }
    } catch (error) {
      if (error instanceof GithubApiReadError && error.providerStatus === 401)
        this.options.connections.recordReadFailure(
          eligible.connection.id,
          eligible.connection.authorizationRevision,
          'needs_reconnect',
          error.message,
        )
      else if (error instanceof McpClientError && error.kind === 'schema_changed')
        this.options.connections.recordReadFailure(
          eligible.connection.id,
          eligible.connection.authorizationRevision,
          'degraded',
          'The reviewed GitHub tool schema changed. Review the connection before reading again.',
        )
      throw error
    } finally {
      this.active.delete(controller)
      input.signal?.removeEventListener('abort', abort)
    }
  }

  async listOpenIssues(input: {
    spaceId: string
    accountHint?: string
    connectionId?: string
    repository: { owner: string; name: string }
    signal?: AbortSignal
  }): Promise<{
    text: string
    connection: ServiceConnection
    grant: SpaceCapabilityGrant
    origin: string
  }> {
    const eligible = this.options.connections.eligible({
      spaceId: input.spaceId,
      service: 'github',
      action: 'list_issues',
      repository: input.repository,
      ...(input.accountHint ? { accountHint: input.accountHint } : {}),
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    })
    if (!eligible?.credentialRef || !this.options.vault)
      throw new ServiceConnectionError(403, 'GitHub is not granted for this Space and repository')
    const token = this.options.vault.resolve(eligible.credentialRef)
    if (!token) throw new ServiceConnectionError(409, 'GitHub connection needs reconnection')
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })
    this.active.set(controller, {
      spaceId: input.spaceId,
      connectionId: eligible.connection.id,
      grantId: eligible.grant.id,
      action: 'list_issues',
      repository: input.repository,
    })
    try {
      const executable = await (this.options.install ?? installReviewedGithubMcp)(
        this.options.rootDir,
        { signal: controller.signal },
      )
      const client = this.client(executable, token, 'read')
      try {
        await client.start()
        const result = await client.listOpenIssues(
          input.repository.owner,
          input.repository.name,
          controller.signal,
        )
        const current = this.options.connections.eligible({
          spaceId: input.spaceId,
          service: 'github',
          action: 'list_issues',
          repository: input.repository,
          connectionId: eligible.connection.id,
        })
        if (!current || current.grant.id !== eligible.grant.id)
          throw new ServiceConnectionError(403, 'GitHub Space grant changed during the call')
        return {
          text: result.text,
          connection: current.connection,
          grant: current.grant,
          origin: `untrusted:github-mcp-${current.connection.id}`,
        }
      } finally {
        await client.stop()
      }
    } finally {
      this.active.delete(controller)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  async createIssue(input: {
    effectId: string
    spaceId: string
    repository: { owner: string; name: string }
    title: string
    body: string
    signal?: AbortSignal
  }): Promise<{ number: number; connection: ServiceConnection; grant: SpaceCapabilityGrant }> {
    const eligible = this.options.connections.eligible({
      spaceId: input.spaceId,
      service: 'github',
      action: 'issue_write',
      repository: input.repository,
    })
    if (!eligible?.credentialRef || !this.options.vault)
      throw new ServiceConnectionError(
        403,
        'GitHub write is not granted for this Space and repository',
      )
    const token = this.options.vault.resolve(eligible.credentialRef)
    if (!token) throw new ServiceConnectionError(409, 'GitHub connection needs reconnection')
    if (!input.title.trim() || input.title.length > 240 || input.body.length > 10_000)
      throw new ServiceConnectionError(400, 'GitHub issue content exceeds the reviewed bound')
    const effect = {
      effectId: input.effectId,
      spaceId: input.spaceId,
      owner: input.repository.owner,
      repo: input.repository.name,
      title: input.title,
      body: input.body,
    }
    const confirmed = this.effects.status(effect)
    if (confirmed !== undefined)
      return { number: confirmed, connection: eligible.connection, grant: eligible.grant }
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (input.signal?.aborted) controller.abort()
    else input.signal?.addEventListener('abort', onAbort, { once: true })
    this.active.set(controller, {
      spaceId: input.spaceId,
      connectionId: eligible.connection.id,
      grantId: eligible.grant.id,
      action: 'issue_write',
      repository: input.repository,
    })
    try {
      const executable = await (this.options.install ?? installReviewedGithubMcp)(
        this.options.rootDir,
        { signal: controller.signal },
      )
      const client = this.client(executable, token, 'write')
      try {
        await client.start()
        const tool = await client.discoverTools()
        if (tool.name !== 'issue_write' || tool.schemaSha256 !== GITHUB_MCP_SCHEMAS.write.hash)
          throw new McpClientError('schema_changed', 'Required GitHub write capability changed')
        const current = this.options.connections.eligible({
          spaceId: input.spaceId,
          service: 'github',
          action: 'issue_write',
          repository: input.repository,
        })
        if (!current || current.grant.id !== eligible.grant.id || controller.signal.aborted)
          throw new ServiceConnectionError(403, 'GitHub Space grant changed before the write')
        const priorNumber = this.effects.begin(effect)
        if (priorNumber !== undefined)
          return { number: priorNumber, connection: current.connection, grant: current.grant }
        const result = await client.createIssue(
          input.repository.owner,
          input.repository.name,
          input.title,
          input.body,
          controller.signal,
        )
        const number = issueNumberFromMcpResult(result.text, input.repository)
        if (number === undefined)
          throw new Error('GitHub issue outcome is unknown; inspect the repository before retrying')
        await this.verifyCreatedIssue(
          token,
          input.repository,
          number,
          input.title,
          input.body,
          controller.signal,
        )
        this.effects.confirm(input.effectId, number)
        return { number, connection: current.connection, grant: current.grant }
      } finally {
        await client.stop()
      }
    } finally {
      this.active.delete(controller)
      input.signal?.removeEventListener('abort', onAbort)
    }
  }

  stop(): void {
    this.dispose()
    for (const controller of this.active.keys()) controller.abort()
  }

  private client(executable: string, token: string, mode: GithubMcpMode): GithubMcpSession {
    const input = { executable, cwd: this.options.rootDir, token, mode }
    return (
      this.options.createClient?.(input) ??
      new McpStdioClient({
        ...input,
        launch: (proxyPort) => reviewedGithubMcpLaunch(executable, this.options.rootDir, proxyPort),
      })
    )
  }

  private async verifyCreatedIssue(
    token: string,
    repository: { owner: string; name: string },
    number: number,
    title: string,
    body: string,
    signal: AbortSignal,
  ): Promise<void> {
    const response = await (this.options.fetchFn ?? fetch)(
      `https://api.github.com/repos/${repository.owner}/${repository.name}/issues/${number}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'veduta-github-mcp-v1.12.2',
        },
        redirect: 'error',
        signal,
      },
    )
    if (!response.ok) throw new Error('GitHub issue write could not be confirmed')
    const text = await response.text()
    if (Buffer.byteLength(text) > 32 * 1024)
      throw new Error('GitHub issue confirmation exceeded the bound')
    const issue = z
      .object({
        number: z.number().int().positive(),
        title: z.string(),
        body: z.string().nullable(),
      })
      .parse(JSON.parse(text))
    if (issue.number !== number || issue.title !== title || (issue.body ?? '') !== body)
      throw new Error('GitHub issue write did not match the approved content')
  }

  private async verifyAccount(token: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await (this.options.fetchFn ?? fetch)('https://api.github.com/user', {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'veduta-github-mcp-v1.12.2',
        },
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new ServiceConnectionError(502, 'GitHub account verification failed')
      const text = await response.text()
      if (Buffer.byteLength(text) > 16 * 1024)
        throw new ServiceConnectionError(502, 'GitHub account response was too large')
      return Profile.parse(JSON.parse(text)).login
    } finally {
      clearTimeout(timer)
    }
  }

  private cancelRevokedCalls(): void {
    for (const [controller, call] of this.active) {
      const current = this.options.connections.eligible({
        spaceId: call.spaceId,
        service: 'github',
        action: call.action,
        connectionId: call.connectionId,
        ...(call.repository ? { repository: call.repository } : {}),
      })
      if (current?.grant.id !== call.grantId) controller.abort()
    }
  }
}

function issueNumberFromMcpResult(
  text: string,
  repository: { owner: string; name: string },
): number | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  const find = (item: unknown, depth: number): number | undefined => {
    if (depth > 4 || item === null || typeof item !== 'object') return undefined
    if (Array.isArray(item)) {
      for (const child of item.slice(0, 10)) {
        const number = find(child, depth + 1)
        if (number !== undefined) return number
      }
      return undefined
    }
    const record = item as Record<string, unknown>
    const number = record['number']
    if (
      number !== undefined &&
      !(typeof number === 'number' && Number.isSafeInteger(number) && number > 0)
    )
      return undefined
    if (record['url'] !== undefined) {
      const fromUrl = issueNumberFromGithubUrl(record['url'], repository)
      if (fromUrl === undefined || (number !== undefined && number !== fromUrl)) return undefined
      return fromUrl
    }
    if (typeof number === 'number') return number
    for (const child of Object.values(record).slice(0, 20)) {
      const number = find(child, depth + 1)
      if (number !== undefined) return number
    }
    return undefined
  }
  return find(value, 0)
}

function issueNumberFromGithubUrl(
  value: unknown,
  repository: { owner: string; name: string },
): number | undefined {
  if (typeof value !== 'string') return undefined
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.href !== value || url.username || url.password || url.search || url.hash) return undefined
  let path: string
  if (url.origin === 'https://github.com') path = url.pathname
  else if (url.origin === 'https://api.github.com' && url.pathname.startsWith('/repos/'))
    path = url.pathname.slice('/repos'.length)
  else return undefined
  const match = path.match(/^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/)
  if (
    !match ||
    match[1]?.toLowerCase() !== repository.owner.toLowerCase() ||
    match[2]?.toLowerCase() !== repository.name.toLowerCase()
  )
    return undefined
  const number = Number(match[3])
  return Number.isSafeInteger(number) ? number : undefined
}
