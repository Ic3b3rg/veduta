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
import { ServiceConnectionError, type ServiceConnections } from './service-connections.ts'
import type { SecretsVault } from './secrets-vault.ts'

const REVIEWED_READ_SCHEMA = '56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119'
const REVIEWED_WRITE_SCHEMA = '97fade9d761e39e29714162058cbcc5a484d65372be703889dd86f9d062c811b'
const SOURCE = 'https://github.com/github/github-mcp-server/releases/tag/v1.12.2'
const Profile = z.object({ login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/) })

export type GithubMcpSession = Pick<
  McpStdioClient,
  'start' | 'discoverTools' | 'listOpenIssues' | 'createIssue' | 'stop'
>

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
    toolSchemaSha256: mode === 'write' ? REVIEWED_WRITE_SCHEMA : REVIEWED_READ_SCHEMA,
    repository: { owner, name },
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
      action: 'list_issues' | 'issue_write'
      repository: { owner: string; name: string }
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
        mode: 'read' | 'write'
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
      const mode = attempt.review.actions.includes('issue_write') ? 'write' : 'read'
      const client = this.client(executable, token, mode)
      try {
        await client.start()
        const tool = await client.discoverTools()
        if (
          tool.name !== (mode === 'write' ? 'issue_write' : 'list_issues') ||
          tool.schemaSha256 !== attempt.review.toolSchemaSha256
        )
          throw new Error('Required GitHub tool schema changed')
      } finally {
        await client.stop()
      }
      this.options.vault.set(credentialRef.slice('secret://vault/'.length), token)
      this.options.connections.verified(attemptId, {
        connectionId: `svc-github-${randomUUID()}`,
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

  async listOpenIssues(input: {
    spaceId: string
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
        if (tool.name !== 'issue_write' || tool.schemaSha256 !== REVIEWED_WRITE_SCHEMA)
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
        const number = issueNumberFromMcpResult(result.text)
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

  private client(executable: string, token: string, mode: 'read' | 'write'): GithubMcpSession {
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
        repository: call.repository,
      })
      if (current?.grant.id !== call.grantId) controller.abort()
    }
  }
}

function issueNumberFromMcpResult(text: string): number | undefined {
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
    if (
      typeof record['number'] === 'number' &&
      Number.isSafeInteger(record['number']) &&
      record['number'] > 0
    )
      return record['number']
    for (const child of Object.values(record).slice(0, 20)) {
      const number = find(child, depth + 1)
      if (number !== undefined) return number
    }
    return undefined
  }
  return find(value, 0)
}
