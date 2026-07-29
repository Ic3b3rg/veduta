import type { FactRecord, FactsDocument } from './facts.ts'
import { isUntrusted, untrustedDataBlock, untrustedSource, type Origin } from './taint.ts'

export interface FactsProjection {
  /** The full FACTS section as injected into context: active facts, then the superseded tail. */
  text: string
  /** The untrusted origins of exactly what `text` renders. */
  origins: Origin[]
  /** Rendered length of the ACTIVE portion only, in UTF-16 code units. */
  activeSize: number
}

/**
 * The single traversal of a `FactsDocument` that both the context injected
 * into a turn (`SpacesEngine.assembleContext`) and the taint gating that turn
 * (`SpacesEngine.contextOrigins`) must read from, so the two can never drift
 * apart (issues/021-advanced-memory.md, issues/032-facts-hygiene-context-budget.md).
 * Before this function existed, `spaces-engine.ts` walked the document twice —
 * once to render FACTS, once to collect origins — and the two walks happened
 * to agree only because nobody had changed one without the other yet.
 *
 * Dormant records are excluded from all three fields: they are kept on disk
 * and still valid (`facts.ts`), but are not injected into context by
 * default, so they must render no text and contribute no origin here. A
 * dormant fact that is later retrieved on demand taints the turn through the
 * retrieving tool's own reported origins instead, not through this
 * projection.
 *
 * `origins` lists each untrusted origin once, in first-appearance order,
 * walking active records before superseded ones — a superseded fact still
 * renders into `text` (in the "Superseded:" tail), so its origin must still
 * gate the turn even after a trusted fact has superseded it.
 *
 * `activeSize` is read off the same array of rendered active lines used to
 * build `text` — never by re-rendering or by searching `text` for the
 * "Superseded:" label — so it can never disagree with what `text` actually
 * contains. Its unit is UTF-16 code units (`string.length`), not a token
 * count: computing it is `O(projection length)`, with no tokenizer involved.
 */
export function projectFacts(document: FactsDocument): FactsProjection {
  const origins: Origin[] = []
  const seenOrigins = new Set<Origin>()
  const recordOrigin = (fact: FactRecord): void => {
    if (fact.origin && isUntrusted(fact.origin) && !seenOrigins.has(fact.origin)) {
      seenOrigins.add(fact.origin)
      origins.push(fact.origin)
    }
  }

  const active =
    document.active.length === 0
      ? ['No active facts noted.']
      : document.active.map((fact) => {
          recordOrigin(fact)
          return factLineWithOriginMark(fact, `noted: ${fact.noted ?? 'undated'}`)
        })
  const activeSize = active.join('\n').length

  const superseded =
    document.superseded.length === 0
      ? ['No superseded facts.']
      : document.superseded.map((fact) => {
          recordOrigin(fact)
          const supersededAt = fact.supersededAt ? `; superseded: ${fact.supersededAt}` : ''
          return factLineWithOriginMark(fact, `noted: ${fact.noted ?? 'undated'}${supersededAt}`)
        })

  const text = [...active, '', 'Superseded:', ...superseded].join('\n')
  return { text, origins, activeSize }
}

/**
 * The one taint-aware rendering of a FACTS line, for anything that shows a
 * fact to the Agent — the injected projection above and `search_memory`'s
 * retrieved hits alike. Exported so a retrieval result cannot grow a second,
 * independently drifting delimiter scheme: a divergence here is a security
 * divergence, since it decides whether tainted text ever appears outside its
 * block (docs/SECURITY.md §3.2).
 */
export function factLineWithOriginMark(fact: FactRecord, metadata: string): string {
  if (!fact.origin || !isUntrusted(fact.origin)) return `- ${fact.text} (${metadata})`
  // Untrusted fact text lives only inside the delimited block; the plain
  // line carries content-free metadata so no tainted text ever renders
  // outside the delimiters (docs/SECURITY.md §3.2).
  const source = untrustedSource(fact.origin) ?? 'external'
  const line = `- (untrusted fact from "${source}"; ${metadata}) [${fact.origin}]`
  return `${line}\n${untrustedDataBlock(source, [['fact', fact.text]])}`
}
