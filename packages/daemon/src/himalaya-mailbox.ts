import { z } from 'zod'
import type { RawMail } from './gmail-mailbox.ts'
import type { HimalayaConnections } from './himalaya-connections.ts'
import type { MailboxAccount, MailboxScope } from './mailbox-scope.ts'

const EnvelopeSchema = z.object({
  id: z.union([z.string(), z.number()]),
  subject: z.string().optional(),
  from: z.unknown().optional(),
  date: z.string().nullable().optional(),
  flags: z.array(z.object({ raw: z.string(), iana: z.string().nullable().optional() })).optional(),
})
const SearchSchema = z.object({ envelopes: z.array(EnvelopeSchema) })

function sender(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 500)
  if (Array.isArray(value)) return value.map(sender).filter(Boolean).join(', ').slice(0, 500)
  if (typeof value === 'object' && value !== null) {
    const object = value as Record<string, unknown>
    return [object['name'], object['email']]
      .filter((part) => typeof part === 'string')
      .join(' ')
      .slice(0, 500)
  }
  return ''
}

function queryFor(scope: MailboxScope): string {
  const clauses = [
    scope.kind === 'receipts'
      ? '(subject receipt or subject invoice)'
      : scope.kind === 'newsletters'
        ? 'subject newsletter'
        : scope.kind === 'sender'
          ? `from ${scope.query}`
          : `subject "${scope.query}"`,
    ...(scope.kind !== 'sender' && scope.sender ? [`from ${scope.sender}`] : []),
    ...(scope.kind !== 'subject' && scope.subject ? [`subject "${scope.subject}"`] : []),
    ...(scope.unreadOnly ? ['not flag seen'] : []),
    ...(scope.window.kind === 'dates'
      ? [
          `after ${scope.window.after.replaceAll('/', '-')}`,
          `not after ${scope.window.before.replaceAll('/', '-')}`,
        ]
      : []),
  ]
  return `${clauses.join(' and ')} order by date desc`
}

export class HimalayaMailbox {
  constructor(private readonly connections: HimalayaConnections) {}

  accounts(): MailboxAccount[] {
    return this.connections
      .snapshot()
      .connections.filter((record) => record.state === 'ready' && record.address)
      .map((record) => ({
        id: record.id,
        provider: 'himalaya' as const,
        name: record.name,
        address: record.address!,
      }))
  }

  async search(scope: MailboxScope, signal?: AbortSignal): Promise<RawMail[]> {
    if (scope.account.provider !== 'himalaya') throw new Error('Mailbox provider mismatch')
    const args = [
      'envelope',
      'search',
      '-m',
      scope.folder,
      '-p',
      '1',
      '-s',
      String(scope.limit),
      queryFor(scope),
    ]
    const json = await this.connections.executeForAccount(scope.account.id, args, true, signal)
    let search: z.infer<typeof SearchSchema>
    try {
      search = SearchSchema.parse(JSON.parse(json))
    } catch {
      throw new Error('Himalaya returned malformed search output')
    }
    const result: RawMail[] = []
    for (const envelope of search.envelopes.slice(0, scope.limit)) {
      if (
        scope.unreadOnly &&
        envelope.flags?.some((flag) => flag.iana === 'seen' || flag.raw.toLowerCase() === '\\seen')
      ) {
        continue
      }
      const id = String(envelope.id)
      const body = await this.connections.executeForAccount(
        scope.account.id,
        ['message', 'read', '-m', scope.folder, id],
        false,
        signal,
      )
      const dateMs = envelope.date == null ? NaN : Date.parse(envelope.date)
      result.push({
        providerId: id,
        sender: sender(envelope.from),
        subject: (envelope.subject ?? '').slice(0, 500),
        body: body.slice(0, 16_384),
        ...(Number.isFinite(dateMs) ? { receivedAt: new Date(dateMs).toISOString() } : {}),
      })
    }
    return result
  }
}
