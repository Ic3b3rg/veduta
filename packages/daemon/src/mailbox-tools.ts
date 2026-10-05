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
import type { ServiceRequestFor } from './service-request.ts'

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
  requestFor?: ServiceRequestFor
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
  const resolved = new Map<string, { scope: MailboxScope; request: string }>()
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
        const operation = options.requestFor?.(context)
        const accounts = options.providers.flatMap((provider) => provider.accounts())
        const candidates = accounts.filter(
          (account) =>
            account.provider === 'gmail' &&
            (operation?.action !== 'search_mailbox' ||
              operation.account === undefined ||
              [account.id, account.name, account.address].some(
                (value) => value.toLowerCase() === operation.account!.toLowerCase(),
              )),
        )
        const resolution =
          operation?.action === 'search_mailbox'
            ? candidates.length === 1
              ? {
                  status: 'resolved' as const,
                  scope: {
                    account: candidates[0]!,
                    kind: 'query' as const,
                    query: operation.query,
                    folder: operation.folder,
                    unreadOnly: operation.unreadOnly,
                    limit: operation.limit,
                    newest: operation.newest,
                    window: { kind: 'all' as const },
                  },
                }
              : {
                  status: 'clarify' as const,
                  question:
                    candidates.length === 0
                      ? 'The requested Gmail account is not granted for this Space. Review Service connections.'
                      : `Which Mailbox account should I use: ${candidates.map((account) => account.address).join(', ')}?`,
                }
            : resolveMailboxScope(
                context.currentUserRequest.text,
                options.requestFor
                  ? accounts.filter((account) => account.provider === 'himalaya')
                  : accounts,
                options.now(),
                options.timeZone,
              )
        if (resolution.status === 'clarify') return { content: resolution.question }
        const scopeId = randomUUID()
        resolved.set(scopeId, {
          scope: resolution.scope,
          request: JSON.stringify([
            context.initiatingTurn?.turnId,
            context.currentUserRequest.text,
            operation,
          ]),
        })
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
        const sealed = resolved.get(scopeId)
        if (
          !sealed ||
          sealed.request !==
            JSON.stringify([
              context.initiatingTurn?.turnId,
              context.currentUserRequest.text,
              options.requestFor?.(context),
            ])
        )
          return { content: 'Resolve the Mailbox scope in this turn first.' }
        resolved.delete(scopeId)
        const { scope } = sealed
        const provider = options.providers.find((candidate) =>
          candidate.accounts().some((account) => account.id === scope.account.id),
        )
        if (!provider) return { content: 'Mailbox connection is no longer available.' }
        const raw = await provider.search(scope, context.signal)
        const summaries: MailSummary[] = []
        for (const message of raw.slice(0, scope.limit)) {
          summaries.push(await options.reader.extract(options.spaceId, message))
        }
        context.signal?.throwIfAborted()
        if (!provider.accounts().some((account) => account.id === scope.account.id))
          throw new Error(
            'Mailbox access changed before the summary could be saved. Review Service connections.',
          )
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
