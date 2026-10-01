import { describe, expect, it } from 'vitest'
import { gmailQuery, resolveMailboxScope, type MailboxAccount } from './mailbox-scope.ts'

const account: MailboxAccount = {
  id: 'svc-gmail-1',
  provider: 'gmail',
  name: 'Personal',
  address: 'one@gmail.test',
}

describe('trusted Mailbox scope resolution', () => {
  it('bounds unread receipts to the current local week across a month boundary', () => {
    const result = resolveMailboxScope(
      'Show unread receipts from this week',
      [account],
      new Date('2026-10-01T12:00:00Z'),
      'Europe/Rome',
    )
    expect(result.status).toBe('resolved')
    if (result.status !== 'resolved') return
    expect(result.scope.window).toEqual({
      kind: 'dates',
      after: '2026/09/28',
      before: '2026/10/05',
      afterEpoch: 1790546400,
      beforeEpoch: 1791151200,
    })
    expect(gmailQuery(result.scope)).toBe(
      '{receipt invoice} is:unread after:1790546400 before:1791151200',
    )
    expect(result.scope.limit).toBe(20)
  })

  it('bounds the last five newsletters and refuses ambiguous accounts or open-ended work', () => {
    const now = new Date('2026-10-01T12:00:00Z')
    const second = { ...account, id: 'svc-gmail-2', name: 'Work', address: 'two@gmail.test' }
    expect(
      resolveMailboxScope('Summarize the last five newsletters', [account], now, 'UTC'),
    ).toEqual({
      status: 'resolved',
      scope: {
        account,
        kind: 'newsletters',
        query: 'newsletter',
        folder: 'ALL',
        unreadOnly: false,
        limit: 5,
        window: { kind: 'all' },
      },
    })
    expect(
      resolveMailboxScope('Summarize the last five newsletters', [account, second], now, 'UTC')
        .status,
    ).toBe('clarify')
    expect(resolveMailboxScope('Show receipts', [account], now, 'UTC').status).toBe('clarify')
    expect(resolveMailboxScope('Show my mail', [account], now, 'UTC').status).toBe('clarify')
    expect(resolveMailboxScope('Show last 100 newsletters', [account], now, 'UTC').status).toBe(
      'clarify',
    )
  })

  it('keeps sender and subject filters in the resolved provider query', () => {
    const now = new Date('2026-10-01T12:00:00Z')
    const newsletters = resolveMailboxScope(
      'Summarize the last five newsletters from editor@example.test',
      [account],
      now,
      'UTC',
    )
    expect(newsletters.status).toBe('resolved')
    if (newsletters.status === 'resolved') {
      expect(gmailQuery(newsletters.scope)).toBe('newsletter from:editor@example.test')
    }
    const subject = resolveMailboxScope(
      'Show last three messages with subject "Quarterly report"',
      [account],
      now,
      'UTC',
    )
    expect(subject.status).toBe('resolved')
    if (subject.status === 'resolved') {
      expect(gmailQuery(subject.scope)).toBe('subject:"Quarterly report"')
    }
  })

  it('uses the selected mailbox and local midnight instants for Gmail searches', () => {
    const now = new Date('2026-10-01T12:00:00Z')
    const archive = resolveMailboxScope(
      'Show unread receipts in Archive this week',
      [account],
      now,
      'Europe/Rome',
    )
    expect(archive.status).toBe('resolved')
    if (archive.status !== 'resolved') return
    expect(archive.scope.folder).toBe('Archive')
    expect(gmailQuery(archive.scope)).toBe(
      '{receipt invoice} in:archive is:unread after:1790546400 before:1791151200',
    )
    const namedLabel = resolveMailboxScope(
      'Show last five newsletters in Travel Receipts label',
      [account],
      now,
      'Europe/Rome',
    )
    expect(namedLabel.status).toBe('resolved')
    if (namedLabel.status === 'resolved') {
      expect(namedLabel.scope.folder).toBe('Travel Receipts')
      expect(gmailQuery(namedLabel.scope)).toContain('label:"Travel Receipts"')
    }
    expect(
      resolveMailboxScope('Show receipts in an unspecified folder this week', [account], now, 'UTC')
        .status,
    ).toBe('clarify')
  })
})
