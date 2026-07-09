import { z } from 'zod'
import type { ExternalEvent } from './external-event.ts'

/**
 * Deterministic pre-filters (issue #12, ADR-0005 level 2): configurable
 * rules that run in milliseconds before any LLM. Every discard carries a
 * reason so the queue stays auditable. The optional similarity hook is
 * the seam for embedding-based filtering — injected, never implemented
 * here, absent by default.
 */
export const PreFilterRulesSchema = z.object({
  /** addr-spec (`a@b.c`) or domain suffix (`@b.c`). Allow wins over the newsletter rule. */
  allowSenders: z.array(z.string().min(1)).default([]),
  blockSenders: z.array(z.string().min(1)).default([]),
  /** When present, only these event types survive. */
  allowTypes: z.array(z.string().min(1)).optional(),
  blockTypes: z.array(z.string().min(1)).default([]),
  /** Newsletter heuristic over email headers (List-Unsubscribe, Precedence). */
  discardNewsletters: z.boolean().default(true),
  /** Events scoring below this via the injected hook are discarded. */
  similarityThreshold: z.number().min(0).max(1).optional(),
})

export type PreFilterRules = z.infer<typeof PreFilterRulesSchema>

export type PreFilterVerdict = { verdict: 'accept' } | { verdict: 'discard'; reason: string }

/** Embedding-similarity seam: returns a 0..1 score, or undefined to abstain. */
export type SimilarityHook = (event: ExternalEvent) => number | undefined

/**
 * Extract the addr-spec from an RFC 5322 `From`-style value
 * (`Display Name <user@host>` or a bare address), lowercased.
 */
export function parseAddrSpec(from: string): string | undefined {
  const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(from)
  const candidate = angled?.[1] ?? (from.includes('@') ? from.trim() : undefined)
  if (!candidate || !candidate.includes('@')) return undefined
  return candidate.toLowerCase()
}

function senderMatches(addrSpec: string, entry: string): boolean {
  const rule = entry.toLowerCase()
  if (rule.startsWith('@')) return addrSpec.endsWith(rule)
  return addrSpec === rule
}

function matchesAny(addrSpec: string | undefined, entries: string[]): boolean {
  if (!addrSpec) return false
  return entries.some((entry) => senderMatches(addrSpec, entry))
}

function looksLikeNewsletter(event: ExternalEvent): boolean {
  if (event.kind !== 'email') return false
  const headers = event.headers ?? {}
  if (headers['list-unsubscribe'] !== undefined) return true
  const precedence = headers['precedence']?.toLowerCase()
  return precedence === 'bulk' || precedence === 'list'
}

export function evaluatePreFilter(
  event: ExternalEvent,
  rules: PreFilterRules,
  similarity?: SimilarityHook,
): PreFilterVerdict {
  const sender = event.sender === undefined ? undefined : parseAddrSpec(event.sender)

  if (matchesAny(sender, rules.blockSenders)) {
    return { verdict: 'discard', reason: 'sender-blocklisted' }
  }
  if (rules.blockTypes.includes(event.type)) {
    return { verdict: 'discard', reason: 'type-blocked' }
  }
  // An allowlisted sender is an explicit user decision: it beats the
  // newsletter heuristic and the similarity hook, never the blocklists.
  if (matchesAny(sender, rules.allowSenders)) return { verdict: 'accept' }

  if (rules.allowTypes && !rules.allowTypes.includes(event.type)) {
    return { verdict: 'discard', reason: 'type-not-allowed' }
  }
  if (rules.discardNewsletters && looksLikeNewsletter(event)) {
    return { verdict: 'discard', reason: 'newsletter' }
  }
  if (rules.similarityThreshold !== undefined && similarity) {
    const score = similarity(event)
    if (score !== undefined && score < rules.similarityThreshold) {
      return { verdict: 'discard', reason: 'below-similarity-threshold' }
    }
  }
  return { verdict: 'accept' }
}
