import { createHash } from 'node:crypto'
import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { GithubMcpService } from './github-mcp-service.ts'
import { boundedServiceIntent } from './service-intent.ts'
import type { Store } from './store.ts'

interface IssueSummary {
  number: number
  title: string
}

/** MCP content is untrusted; only bounded issue fields become protocol-valid Atom text. */
export function issueSummaries(text: string): IssueSummary[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  const result: IssueSummary[] = []
  const seen = new Set<number>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || result.length >= 10 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 30)) visit(item, depth + 1)
      return
    }
    const record = value as Record<string, unknown>
    if (
      typeof record['number'] === 'number' &&
      Number.isSafeInteger(record['number']) &&
      record['number'] > 0 &&
      typeof record['title'] === 'string' &&
      record['title'].trim() &&
      !seen.has(record['number'])
    ) {
      seen.add(record['number'])
      result.push({ number: record['number'], title: record['title'].trim().slice(0, 240) })
    }
    for (const child of Object.values(record).slice(0, 30)) visit(child, depth + 1)
  }
  visit(parsed, 0)
  return result
}

export function createGithubMcpTools(options: {
  store: Store
  github: GithubMcpService
  spaceId: string
  now: () => Date
}): ToolDef[] {
  return [
    defineTool({
      name: 'list_github_issues',
      description:
        'Read at most ten open issues from one explicitly granted GitHub repository through the reviewed GitHub MCP Server; create a source-linked Surface in the active Space. The repository must match the user request and Space grant.',
      schema: z
        .object({
          owner: z.string().min(1).max(39),
          repo: z.string().min(1).max(100),
        })
        .strict(),
      level: 'R0',
      egressDomains: ['api.github.com'],
      async handler({ owner, repo }, context) {
        if (context.spaceId !== options.spaceId || !context.currentUserRequest)
          return { content: 'A current trusted request in the active Space is required.' }
        const requested = boundedServiceIntent(context.currentUserRequest.text)?.review
        if (
          requested?.service !== 'github' ||
          requested.repository?.owner !== owner ||
          requested.repository?.name !== repo
        )
          return { content: 'The repository must match the current Chat request.' }
        const repository = { owner, name: repo }
        const read = await options.github.listOpenIssues({
          spaceId: options.spaceId,
          repository,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        const issues = issueSummaries(read.text)
        const checkedAt = options.now().toISOString()
        const children: AtomNode[] = issues.length
          ? issues.map((issue) => ({
              id: `issue-${issue.number}`,
              type: 'Box',
              children: [
                {
                  id: `label-${issue.number}`,
                  type: 'ListItem',
                  props: { label: `#${issue.number} ${issue.title}`.slice(0, 240) },
                },
                {
                  id: `source-${issue.number}`,
                  type: 'Markdown',
                  props: {
                    text: `[Open issue #${issue.number}](https://github.com/${owner}/${repo}/issues/${issue.number})`,
                  },
                },
              ],
            }))
          : [{ id: 'empty', type: 'Text', props: { text: 'No open issues were returned.' } }]
        const surfaceId = `srf-github-issues-${createHash('sha256')
          .update(`${context.initiatingTurn?.turnId ?? ''}:${context.toolCallId}`)
          .digest('hex')
          .slice(0, 24)}`
        const surface = SurfaceSchema.parse({
          id: surfaceId,
          spaceId: options.spaceId,
          title: 'GitHub issues',
          tree: {
            id: 'root',
            type: 'Box',
            children: [
              { id: 'title', type: 'Title', props: { text: 'GitHub issues' } },
              { id: 'repo', type: 'Caption', props: { text: `${owner}/${repo} · open issues` } },
              { id: 'checked', type: 'Caption', props: { text: `Last checked ${checkedAt}` } },
              { id: 'results', type: 'Box', children },
            ],
          },
          state: {},
          freshness: { updatedAt: checkedAt, updatedBy: 'agent' },
        })
        const origin = `untrusted:github-mcp-${read.connection.id}` as const
        if (!options.store.getSurface(surfaceId))
          options.store.createSurface(surface, 'agent', {
            origin,
            contentOrigin: origin,
            ...(context.initiatingTurn ? { initiatingTurn: context.initiatingTurn } : {}),
          })
        return {
          content: JSON.stringify({
            repository: `${owner}/${repo}`,
            count: issues.length,
            issues,
            surfaceId: surface.id,
          }),
          details: { surfaceId: surface.id, count: issues.length },
          origins: [origin],
        }
      },
    }),
  ]
}
