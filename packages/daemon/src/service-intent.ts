import { GMAIL_READ_SCOPE, type ConnectionReview } from '@veduta/protocol'
import { githubConnectionReview } from './github-mcp-service.ts'

export interface ServiceIntent {
  review: ConnectionReview
  requestSummary: string
}

export function gmailConnectionReview(accountHint?: string): ConnectionReview {
  return {
    service: 'gmail',
    ...(accountHint ? { accountHint } : {}),
    scopes: [GMAIL_READ_SCOPE],
    actions: ['search_mailbox'],
    executionHost: 'Gateway native HTTPS (Google OAuth and Gmail API)',
  }
}

export interface GithubIssueWrite {
  owner: string
  repo: string
  title: string
  body: string
}

/** Keeps the L1 approval input tied to an explicit, exact Chat request. */
export function parseGithubIssueWrite(text: string): GithubIssueWrite | undefined {
  const match =
    /^create (?:a )?(?:github )?issue (?:in|for) (?:the )?(?:repo(?:sitory)? )?([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}) titled "([^"\n]{1,240})" with body "([^"\n]{1,10000})"(?: (?:in|for) (?:the )?[A-Za-z][A-Za-z0-9 -]{0,49} Space)?[.!]?$/i.exec(
      text.trim(),
    )
  if (!match) return undefined
  return { owner: match[1]!, repo: match[2]!, title: match[3]!, body: match[4]! }
}

/** Recognizes only the two reviewed, bounded first-use requests. Other Chat work stays with the Agent. */
export function boundedServiceIntent(text: string): ServiceIntent | undefined {
  const write = parseGithubIssueWrite(text)
  if (write)
    return {
      review: githubConnectionReview(write.owner, write.repo, undefined, 'write'),
      requestSummary: text.trim().slice(0, 700),
    }
  const github =
    /\b(?:list|show|find|summari[sz]e)\b[^\n]{0,160}\bopen\s+(?:github\s+)?issues?\b[^\n]{0,160}\b(?:in|from|for)\s+(?:the\s+)?(?:repository|repo)?\s*([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\b/i.exec(
      text,
    )
  if (github) {
    return {
      review: githubConnectionReview(github[1]!, github[2]!),
      requestSummary: text.trim().slice(0, 700),
    }
  }
  if (
    /\b(?:find|show|list|summari[sz]e|search)\b[^\n]{0,180}\b(?:unread\s+)?(?:emails?|messages?|mail)\b/i.test(
      text,
    ) &&
    /\b(?:unread|last\s+\d+\s+days?|since\s+\d{4}-\d{2}-\d{2})\b/i.test(text)
  ) {
    const hint =
      /\b(?:using|with|in)\s+(?:my\s+)?(?:gmail\s+)?(?:account\s+)?([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})\b/i.exec(
        text,
      )?.[1]
    return {
      review: gmailConnectionReview(hint),
      requestSummary: text.trim().slice(0, 700),
    }
  }
  return undefined
}

export function targetSpaceForServiceRequest(
  text: string,
  focusedSpaceId: string | undefined,
  spaces: readonly { id: string; name: string; slug: string }[],
): string | undefined {
  if (focusedSpaceId) return focusedSpaceId
  const matches = spaces.filter((space) => {
    const name = escapeRegExp(space.name)
    const slug = escapeRegExp(space.slug)
    return new RegExp(`\\b(?:in|for)\\s+(?:the\\s+)?(?:${name}|${slug})\\s+Space\\b`, 'i').test(
      text,
    )
  })
  return matches.length === 1 ? matches[0]?.id : undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
