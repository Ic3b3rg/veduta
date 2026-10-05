import type { ServiceResolution } from './service-request.ts'
import { boundedServiceIntent } from './service-intent.ts'
import { resolveMailboxScope, gmailQuery, type MailboxAccount } from './mailbox-scope.ts'

/** Deterministic Loopback fixtures only. Live requests use tool-less model interpretation. */
export function mockServiceRequest(
  prompt: string,
  accounts: MailboxAccount[],
  now: Date,
  timeZone: string,
): ServiceResolution {
  const field = (name: string): unknown =>
    JSON.parse(prompt.split(`${name}: `)[1]?.split('\n')[0] ?? 'null')
  const text = String(field('CURRENT user message') ?? '')
  const focused = field('Focused scope') as { type: string; spaceId?: string }
  const spaces = field('Spaces') as { id: string; name: string }[]
  const spaceId =
    focused.spaceId ??
    spaces.find((space) => text.toLowerCase().includes(`${space.name.toLowerCase()} space`))?.id
  const intent = boundedServiceIntent(text)
  if (intent?.review.service === 'github' && intent.review.actions.includes('list_issues')) {
    if (!spaceId)
      return {
        status: 'clarify',
        question: 'Which Space should own this service request? Name one Space before connecting.',
      }
    return {
      status: 'resolved',
      spaceId,
      operation: {
        service: 'github',
        action: 'list_issues',
        owner: intent.review.repository!.owner,
        repo: intent.review.repository!.name,
      },
    }
  }
  const unreadSince =
    /^find unread emails since (\d{4}-\d{2}-\d{2})(?: in [a-z][a-z0-9 -]{0,49} space)?[.!]?$/i.exec(
      text,
    )
  if (unreadSince && spaceId) {
    return {
      status: 'resolved',
      spaceId,
      operation: {
        service: 'gmail',
        action: 'search_mailbox',
        query: `after:${unreadSince[1]!.replaceAll('-', '/')}`,
        folder: 'INBOX',
        unreadOnly: true,
        limit: 20,
        newest: false,
      },
    }
  }
  if (
    /\b(receipts?|newsletters?|subject|messages?\s+from|unread\s+(?:emails?|mail|messages?))\b/i.test(
      text,
    )
  ) {
    if (!spaceId) return { status: 'none' }
    const resolution = resolveMailboxScope(
      text,
      accounts.length
        ? accounts
        : [
            {
              id: 'unconnected',
              provider: 'gmail',
              address: 'placeholder@example.test',
              name: 'Mailbox',
            },
          ],
      now,
      timeZone,
    )
    if (resolution.status === 'clarify') return resolution
    const scope = resolution.scope
    if (scope.account.provider === 'himalaya') return { status: 'none' }
    return {
      status: 'resolved',
      spaceId,
      operation: {
        service: 'gmail',
        action: 'search_mailbox',
        ...(scope.account.id === 'unconnected'
          ? intent?.review.accountHint
            ? { account: intent.review.accountHint }
            : {}
          : { account: scope.account.address }),
        query: gmailQuery({ ...scope, folder: 'ALL', unreadOnly: false }),
        folder: scope.folder,
        unreadOnly: scope.unreadOnly,
        limit: scope.limit,
        newest: false,
      },
    }
  }
  return { status: 'none' }
}
