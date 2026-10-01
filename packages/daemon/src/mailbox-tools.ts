import { randomUUID } from 'node:crypto'
import { SurfaceSchema, type AtomNode } from '@veduta/protocol'
import { z } from 'zod'
import { defineTool, type ToolDef } from './agent-runner.ts'
import type { RawMail } from './gmail-mailbox.ts'
import {
  gmailQuery,
  resolveMailboxScope,
  type MailboxAccount,
  type MailboxScope,
} from './mailbox-scope.ts'
import type { MailboxSummaryReader, MailSummary } from './mailbox-summary-reader.ts'
import type { Store } from './store.ts'

export interface MailboxProvider {
  accounts(): MailboxAccount[]
  search(scope: MailboxScope, signal?: AbortSignal): Promise<RawMail[]>
}

export interface MailboxToolsOptions {
  store: Store
  providers: readonly MailboxProvider[]
  reader: MailboxSummaryReader
  spaceId: string
  timeZone: string
  now: () => Date
}

function resultSurface(
  scope: MailboxScope,
  summaries: MailSummary[],
  spaceId: string,
  checkedAt: string,
) {
  const query = scope.account.provider === 'gmail' ? gmailQuery(scope) : scope.query
  const children: AtomNode[] = summaries.length
    ? summaries.map((summary, index) => ({
        id: `message-${index}`,
        type: 'ListItem',
        props: {
          label: (summary.subject || summary.sender || 'Message').slice(0, 240),
          detail: summary.summary,
        },
      }))
    : [{ id: 'empty', type: 'Text', props: { text: 'No messages matched this scope.' } }]
  return SurfaceSchema.parse({
    id: `srf-mailbox-${randomUUID()}`,
    spaceId,
    title: 'Mailbox',
    tree: {
      id: 'root',
      type: 'Box',
      children: [
        { id: 'title', type: 'Title', props: { text: 'Mailbox' } },
        {
          id: 'scope',
          type: 'Caption',
          props: { text: `${scope.account.name} (${scope.account.address}) · ${query}` },
        },
        { id: 'checked', type: 'Caption', props: { text: `Last checked ${checkedAt}` } },
        { id: 'results', type: 'Box', children },
      ],
    },
    state: {},
    freshness: { updatedAt: checkedAt, updatedBy: 'agent' },
  })
}

export function createMailboxTools(options: MailboxToolsOptions): ToolDef[] {
  const resolved = new Map<string, MailboxScope>()
  return [
    defineTool({
      name: 'resolve_mailbox_scope',
      description:
        'Resolve the active trusted user request to one bounded Mailbox account, query, read-state filter, and time window. Ask for clarification if ambiguous.',
      schema: z.object({}).strict(),
      level: 'L0',
      egressDomains: [],
      handler(_input, context) {
        if (context.currentUserRequest === undefined || context.spaceId !== options.spaceId) {
          return { content: 'A current trusted request in the active Space is required.' }
        }
        const resolution = resolveMailboxScope(
          context.currentUserRequest.text,
          options.providers.flatMap((provider) => provider.accounts()),
          options.now(),
          options.timeZone,
        )
        if (resolution.status === 'clarify') return { content: resolution.question }
        const scopeId = randomUUID()
        resolved.set(scopeId, resolution.scope)
        const scope = resolution.scope
        return {
          content: JSON.stringify({
            scopeId,
            account: scope.account,
            query: scope.account.provider === 'gmail' ? gmailQuery(scope) : scope.query,
            folder: scope.folder,
            unreadOnly: scope.unreadOnly,
            limit: scope.limit,
            window: scope.window,
          }),
        }
      },
    }),
    defineTool({
      name: 'search_mailbox',
      description:
        'Execute one resolved read-only Mailbox scope and create a query-labelled Surface from quarantined summaries. Never retrieves attachments or changes provider read state.',
      schema: z.object({ scopeId: z.string().uuid() }).strict(),
      level: 'R0',
      egressDomains: ['oauth2.googleapis.com', 'gmail.googleapis.com'],
      async handler({ scopeId }, context) {
        if (context.currentUserRequest === undefined || context.spaceId !== options.spaceId) {
          return { content: 'A current trusted request in the active Space is required.' }
        }
        const scope = resolved.get(scopeId)
        if (!scope) return { content: 'Resolve the Mailbox scope in this turn first.' }
        resolved.delete(scopeId)
        const provider = options.providers.find((candidate) =>
          candidate.accounts().some((account) => account.id === scope.account.id),
        )
        if (!provider) return { content: 'Mailbox connection is no longer available.' }
        const raw = await provider.search(scope, context.signal)
        const summaries: MailSummary[] = []
        for (const message of raw.slice(0, scope.limit)) {
          summaries.push(await options.reader.extract(options.spaceId, message))
        }
        const checkedAt = options.now().toISOString()
        const surface = resultSurface(scope, summaries, options.spaceId, checkedAt)
        const origin = `untrusted:${scope.account.provider}` as const
        options.store.createSurface(surface, 'agent', {
          origin,
          contentOrigin: origin,
          ...(context.initiatingTurn === undefined
            ? {}
            : { initiatingTurn: context.initiatingTurn }),
        })
        return {
          content: JSON.stringify({
            account: scope.account.name,
            query: scope.account.provider === 'gmail' ? gmailQuery(scope) : scope.query,
            checkedAt,
            surfaceId: surface.id,
            summaries,
          }),
          details: { surfaceId: surface.id, count: summaries.length },
          origins: [origin],
        }
      },
    }),
  ]
}
