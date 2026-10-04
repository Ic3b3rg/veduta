import { createHash } from 'node:crypto'
import { SurfaceSchema } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { GithubMcpService } from './github-mcp-service.ts'
import type { ServiceRequestFor } from './service-request.ts'
import type { Store } from './store.ts'

export function createGithubRepositoryTools(options: {
  store: Store
  github: GithubMcpService
  spaceId: string
  now: () => Date
  requestFor?: ServiceRequestFor
}): ToolDef[] {
  let discoveryCalls = 0
  return [
    defineTool({
      name: 'list_github_repositories',
      description:
        'List a bounded page of repositories authorized by the GitHub connection and this Space. Only for the resolved repository-discovery request. Use page 1 first; at most five pages. Results include source links and a Space-owned Surface.',
      schema: z
        .object({
          owner: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
            .optional(),
          page: z.number().int().min(1).max(5).default(1),
        })
        .strict(),
      level: 'R0',
      egressDomains: ['api.github.com'],
      async handler({ owner, page }, context) {
        const operation = options.requestFor?.(context)
        if (
          context.spaceId !== options.spaceId ||
          operation?.action !== 'list_repositories' ||
          (operation.owner && operation.owner.toLowerCase() !== owner?.toLowerCase())
        )
          return { content: 'Repository discovery must match the current resolved Chat request.' }
        if (++discoveryCalls > 5)
          return {
            content:
              'The repository discovery limit was reached. Ask to continue with a narrower owner.',
          }
        const result = await options.github.listRepositories({
          spaceId: options.spaceId,
          ...(operation.account ? { accountHint: operation.account } : {}),
          ...(operation.connectionId ? { connectionId: operation.connectionId } : {}),
          page,
          ...(owner ? { owner } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
        })
        const surfaceId = `srf-github-repos-${createHash('sha256').update(`${context.initiatingTurn?.turnId}:${context.toolCallId}`).digest('hex').slice(0, 24)}`
        const checkedAt = options.now().toISOString()
        const surface = SurfaceSchema.parse({
          id: surfaceId,
          spaceId: options.spaceId,
          title: 'GitHub repositories',
          state: {},
          freshness: { updatedAt: checkedAt, updatedBy: 'agent' },
          tree: {
            id: 'root',
            type: 'Box',
            children: [
              { id: 'title', type: 'Title', props: { text: 'GitHub repositories' } },
              {
                id: 'checked',
                type: 'Caption',
                props: { text: `Page ${page} · Last checked ${checkedAt}` },
              },
              ...result.repositories.map((repo, index) => ({
                id: `repo-${index}`,
                type: 'Markdown',
                props: {
                  text: `[${repo.owner}/${repo.name}](${repo.url}) · ${repo.private ? 'Private' : 'Public'}`,
                },
              })),
              {
                id: 'status',
                type: 'Text',
                props: {
                  text: result.hasMore
                    ? 'More repositories may be available on the next page.'
                    : result.repositories.length
                      ? 'End of repository results.'
                      : 'No authorized repositories matched this page.',
                },
              },
            ],
          },
        })
        if (!options.store.getSurface(surface.id))
          options.store.createSurface(surface, 'agent', {
            origin: result.origin,
            contentOrigin: result.origin,
            ...(context.initiatingTurn ? { initiatingTurn: context.initiatingTurn } : {}),
          })
        return {
          content: JSON.stringify({
            repositories: result.repositories,
            page,
            hasMore: result.hasMore,
            surfaceId,
          }),
          details: { surfaceId, count: result.repositories.length },
          origins: [result.origin],
        }
      },
    }),
  ]
}
