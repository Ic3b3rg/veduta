import { SurfaceSchema } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { GithubMcpService } from './github-mcp-service.ts'
import { parseGithubIssueWrite } from './service-intent.ts'
import type { Store } from './store.ts'
import { toolWriteOrigin } from './taint.ts'
import { inheritTrustWrapper, type ToolMeta } from './trust-layer.ts'

const Input = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    title: z.string().trim().min(1).max(240),
    body: z.string().min(1).max(10_000),
  })
  .strict()

/** Registered once: TrustLayer recovery must find the same canonical executor after restart. */
export function createGithubIssueTool(options: {
  store: Store
  github: GithubMcpService
  now: () => Date
}): { tool: ToolDef<typeof Input>; meta: ToolMeta<z.infer<typeof Input>> } {
  return {
    tool: defineTool({
      name: 'create_github_issue',
      description:
        'Create exactly one GitHub issue in an explicitly granted repository. Requires a separate L1 approval card showing repository, title, and body.',
      schema: Input,
      level: 'L1',
      egressDomains: ['api.github.com'],
      async handler(input, context) {
        if (!context.spaceId || !context.effectId)
          throw new Error('GitHub issue creation requires an approved Space effect')
        const repository = { owner: input.owner, name: input.repo }
        const result = await options.github.createIssue({
          effectId: context.effectId,
          spaceId: context.spaceId,
          repository,
          title: input.title,
          body: input.body,
          ...(context.signal ? { signal: context.signal } : {}),
        })
        const surfaceId = `srf-github-issue-${context.effectId}`
        if (!options.store.getSurface(surfaceId)) {
          const updatedAt = options.now().toISOString()
          const surface = SurfaceSchema.parse({
            id: surfaceId,
            spaceId: context.spaceId,
            title: `GitHub issue #${result.number}`,
            tree: {
              id: 'root',
              type: 'Box',
              children: [
                { id: 'title', type: 'Title', props: { text: input.title } },
                { id: 'repo', type: 'Caption', props: { text: `${input.owner}/${input.repo}` } },
                {
                  id: 'source',
                  type: 'Markdown',
                  props: {
                    text: `[Open issue #${result.number}](https://github.com/${input.owner}/${input.repo}/issues/${result.number})`,
                  },
                },
              ],
            },
            state: {},
            freshness: { updatedAt, updatedBy: 'agent' },
          })
          const origin = `untrusted:github-mcp-${result.connection.id}` as const
          options.store.createSurface(surface, 'agent', {
            origin,
            contentOrigin: origin,
            ...(context.initiatingTurn ? { initiatingTurn: context.initiatingTurn } : {}),
          })
        }
        if (
          !options.store.spacesEngine
            .readRecent(context.spaceId, Number.MAX_SAFE_INTEGER)
            .some(
              (event) =>
                event.type === 'github.issue.created' &&
                event.payload?.['effectId'] === context.effectId,
            )
        )
          options.store.spacesEngine.appendEvent(context.spaceId, {
            type: 'github.issue.created',
            text: `Created GitHub issue #${result.number} in ${input.owner}/${input.repo}`,
            origin: toolWriteOrigin(context.origin),
            payload: {
              effectId: context.effectId,
              issueNumber: result.number,
              surfaceId,
              repository: `${input.owner}/${input.repo}`,
            },
          })
        return {
          content: `Created issue #${result.number} in ${input.owner}/${input.repo}.`,
          details: { surfaceId, issueNumber: result.number, effectId: context.effectId },
          origins: [`untrusted:github-mcp-${result.connection.id}`],
        }
      },
    }),
    meta: {
      title: ({ owner, repo }) => `Create GitHub issue in ${owner}/${repo}`,
      summary: ({ owner, repo, title, body }) =>
        `Repository: ${owner}/${repo}\nTitle: ${title}\n\n${body}`,
      editableKeys: [],
    },
  }
}

/** Checks the trusted request before the L1 wrapper can create a decision card. */
export function guardGithubIssueTool(tool: ToolDef, spaceId: string): ToolDef {
  const guarded: ToolDef = {
    ...tool,
    async handler(input, context) {
      const request = context.currentUserRequest?.text
      const parsed = request ? parseGithubIssueWrite(request) : undefined
      if (context.spaceId !== spaceId || !parsed)
        return { content: 'An explicit current GitHub issue request in this Space is required.' }
      if (
        parsed.owner !== input.owner ||
        parsed.repo !== input.repo ||
        parsed.title !== input.title ||
        parsed.body !== input.body
      )
        return { content: 'The GitHub issue must match the current Chat request exactly.' }
      return tool.handler(input, context)
    },
  }
  return inheritTrustWrapper(tool, guarded)
}
