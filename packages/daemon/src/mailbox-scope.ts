import { startOfZonedDay } from './timezone.ts'

export interface MailboxAccount {
  id: string
  provider: 'gmail' | 'himalaya'
  name: string
  address: string
}

export interface MailboxScope {
  account: MailboxAccount
  kind: 'receipts' | 'newsletters' | 'subject' | 'sender'
  query: string
  sender?: string
  subject?: string
  folder: string
  unreadOnly: boolean
  limit: number
  window:
    | { kind: 'all' }
    | { kind: 'dates'; after: string; before: string; afterEpoch: number; beforeEpoch: number }
}

export type ScopeResolution =
  { status: 'resolved'; scope: MailboxScope } | { status: 'clarify'; question: string }

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
}

function localDate(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const part = (name: string) => parts.find((item) => item.type === name)?.value ?? ''
  return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`)
}

function dateLabel(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '/')
}

function windowFor(text: string, now: Date, timeZone: string): MailboxScope['window'] | undefined {
  const today = localDate(now, timeZone)
  const after = new Date(today)
  const before = new Date(today)
  if (/\bthis week\b/i.test(text)) {
    const weekday = (today.getUTCDay() + 6) % 7
    after.setUTCDate(today.getUTCDate() - weekday)
    before.setTime(after.getTime() + 7 * 86_400_000)
  } else if (/\blast week\b/i.test(text)) {
    const weekday = (today.getUTCDay() + 6) % 7
    after.setUTCDate(today.getUTCDate() - weekday - 7)
    before.setTime(after.getTime() + 7 * 86_400_000)
  } else if (/\byesterday\b/i.test(text)) {
    after.setUTCDate(today.getUTCDate() - 1)
  } else if (/\btoday\b/i.test(text)) {
    before.setUTCDate(today.getUTCDate() + 1)
  } else {
    return undefined
  }
  const epochAtLocalMidnight = (date: Date) =>
    Math.floor(
      startOfZonedDay(timeZone, {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      }).getTime() / 1000,
    )
  return {
    kind: 'dates',
    after: dateLabel(after),
    before: dateLabel(before),
    afterEpoch: epochAtLocalMidnight(after),
    beforeEpoch: epochAtLocalMidnight(before),
  }
}

function requestedFolder(
  request: string,
  provider: MailboxAccount['provider'],
): { status: 'resolved'; folder: string } | { status: 'clarify' } {
  const explicit =
    /\bin(?::|\s+)(?:the\s+)?([a-z][a-z0-9 _-]{0,79}?)(?=\s+(?:this week|last week|today|yesterday|unread|from|subject)|$)/i.exec(
      request,
    )
  if (!explicit && /\bin(?::|\s+)/i.test(request)) return { status: 'clarify' }
  const raw = explicit?.[1]?.replace(/\s+(?:label|folder|mailbox)$/i, '').trim()
  if (raw && /^(?:a|an|my|some|any|unspecified|an? unspecified)(?:\s|$)/i.test(raw))
    return { status: 'clarify' }
  if (raw && !/^[a-z][a-z0-9 _-]{0,79}$/i.test(raw)) return { status: 'clarify' }
  if (raw) {
    const lower = raw.toLowerCase()
    if (lower === 'all' || lower === 'all mail') return { status: 'resolved', folder: 'ALL' }
    if (lower === 'inbox') return { status: 'resolved', folder: 'INBOX' }
    return { status: 'resolved', folder: raw }
  }
  return {
    status: 'resolved',
    folder: /\binbox\b/i.test(request) || provider === 'himalaya' ? 'INBOX' : 'ALL',
  }
}

/** The current trusted request, not model supplied arguments, fixes provider access bounds. */
export function resolveMailboxScope(
  request: string,
  accounts: readonly MailboxAccount[],
  now: Date,
  timeZone: string,
): ScopeResolution {
  const ready = accounts.filter((account) => account.address.length > 0)
  if (ready.length === 0) {
    return { status: 'clarify', question: 'Connect a Mailbox account in Settings first.' }
  }
  const named = ready.filter(
    (account) =>
      request.toLowerCase().includes(account.address.toLowerCase()) ||
      (account.name.length > 2 &&
        new RegExp(`\\b${account.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
          request,
        )),
  )
  if (named.length > 1 || (ready.length > 1 && named.length !== 1)) {
    return {
      status: 'clarify',
      question: `Which Mailbox account should I use: ${ready.map((account) => account.name).join(', ')}?`,
    }
  }
  const account = named[0] ?? ready[0]!
  const folder = requestedFolder(request, account.provider)
  if (folder.status === 'clarify')
    return { status: 'clarify', question: 'Which exact Mailbox folder or label should I search?' }
  const sender = /\b(?:from|sender)\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i.exec(request)?.[1]
  const subject =
    /\bsubject\s+["']?([a-z0-9][a-z0-9 _.-]{0,79})["']?(?=\s+(?:from|in|this|last|today|yesterday|unread)|$)/i
      .exec(request)?.[1]
      ?.trim()
  const kind = /\b(receipts?|invoices?)\b/i.test(request)
    ? 'receipts'
    : /\bnewsletters?\b/i.test(request)
      ? 'newsletters'
      : sender
        ? 'sender'
        : subject
          ? 'subject'
          : undefined
  if (!kind) {
    return {
      status: 'clarify',
      question: 'Which messages should I search for? Please give a subject, sender, or category.',
    }
  }
  const number =
    /\b(?:last|latest|newest|first)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(
      request,
    )?.[1]
  const requestedLimit = number ? (NUMBER_WORDS[number.toLowerCase()] ?? Number(number)) : undefined
  if (requestedLimit !== undefined && (requestedLimit < 1 || requestedLimit > 20)) {
    return { status: 'clarify', question: 'Choose a result limit between 1 and 20.' }
  }
  if (/\b(this month|recently|sometime|last month)\b/i.test(request)) {
    return { status: 'clarify', question: 'What exact time window should I use?' }
  }
  const window = windowFor(request, now, timeZone)
  if (!window && requestedLimit === undefined) {
    return { status: 'clarify', question: 'What time window or result limit should I use?' }
  }
  return {
    status: 'resolved',
    scope: {
      account,
      kind,
      query:
        kind === 'receipts'
          ? '{receipt invoice}'
          : kind === 'newsletters'
            ? 'newsletter'
            : kind === 'sender'
              ? sender!
              : subject!,
      ...(sender === undefined ? {} : { sender }),
      ...(subject === undefined ? {} : { subject }),
      folder: folder.folder,
      unreadOnly: /\bunread\b/i.test(request),
      limit: requestedLimit ?? 20,
      window: window ?? { kind: 'all' },
    },
  }
}

export function gmailQuery(scope: MailboxScope): string {
  return [
    scope.kind === 'subject'
      ? `subject:"${scope.query}"`
      : scope.kind === 'sender'
        ? `from:${scope.query}`
        : scope.query,
    ...(scope.kind !== 'sender' && scope.sender ? [`from:${scope.sender}`] : []),
    ...(scope.kind !== 'subject' && scope.subject ? [`subject:"${scope.subject}"`] : []),
    scope.folder === 'ALL'
      ? ''
      : /^(?:INBOX|Archive|Sent|Trash|Spam|Drafts)$/i.test(scope.folder)
        ? `in:${scope.folder.toLowerCase()}`
        : `label:"${scope.folder}"`,
    scope.unreadOnly ? 'is:unread' : '',
    scope.window.kind === 'dates'
      ? `after:${scope.window.afterEpoch} before:${scope.window.beforeEpoch}`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
}
