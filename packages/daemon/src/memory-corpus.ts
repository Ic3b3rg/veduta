import type { JsonObject } from '@veduta/protocol'
import { factRecordIds } from './facts.ts'
import type { SpacesEngine } from './spaces-engine.ts'
import type { Origin } from './taint.ts'

/**
 * A pinned, fully deterministic ~3-month fixture corpus for the evaluation
 * mini-suite (issues/021-advanced-memory.md's "Evaluation" task; the
 * temporal/update/abstention categories `docs/references/06-memory-research.md`
 * points at). Every timestamp and every string below is a literal or is
 * derived from literals by pure calendar arithmetic (`Date.UTC` on fixed
 * numbers) — no `Date.now()`, no `Math.random()` — so the corpus is
 * byte-identical on every machine and a drift in `memory-eval.test.ts`'s
 * pinned expectations fails loudly instead of quietly passing on one
 * developer's laptop.
 *
 * Everything is written through `SpacesEngine`'s own public methods
 * (`createSpace`, `appendEvent` with an explicit `at`, `writeFact`,
 * `demoteFacts`) so the fixture exercises the real on-disk format
 * (`docs/adr/0006-file-based-memory.md`) rather than a hand-built one.
 *
 * Every date used below outside the daily weight log (fillers, the
 * knowledge-update pair, the two recorded-late events) deliberately avoids
 * `CORPUS_START_OF_JUNE_DATES`, `CORPUS_END_OF_MAY_DATES`, and their two
 * timezone-shifted variants (2026-05-25 through 2026-06-08 inclusive): every
 * one of those 15 calendar days must carry exactly one event — that day's
 * weight entry — so its source reference is always `event:<spaceId>/<day>.jsonl#1`
 * and `memory-eval.test.ts` can build the pinned `sourceRef` lists the
 * evaluation suite asserts without re-deriving that arithmetic itself.
 */

export const CORPUS_SPACE_SLUG = 'health'
export const CORPUS_TIMEZONE = 'Europe/Rome'
/** The instant every query in the suite is evaluated at. */
export const CORPUS_NOW = '2026-07-28T09:00:00.000Z'

const DAY_MS = 24 * 60 * 60 * 1000

/** Inclusive range of calendar dates (`YYYY-MM-DD`, UTC), oldest first. Pure `Date.UTC` arithmetic on fixed literals. */
function daysBetweenInclusive(
  startYear: number,
  startMonth: number,
  startDay: number,
  endYear: number,
  endMonth: number,
  endDay: number,
): string[] {
  const start = Date.UTC(startYear, startMonth - 1, startDay)
  const end = Date.UTC(endYear, endMonth - 1, endDay)
  const dates: string[] = []
  for (let t = start; t <= end; t += DAY_MS) {
    dates.push(new Date(t).toISOString().slice(0, 10))
  }
  return dates
}

/**
 * One weigh-in per day, 2026-04-01 through 2026-06-30 inclusive (91 days):
 * the "3 months of log" acceptance criterion's fixture. Recorded at
 * `10:00:00.000Z` every day so the timezone-shift test (`memory-eval.test.ts`)
 * can reason about the boundary in pure UTC-offset terms rather than fighting
 * this module's own choice of hour.
 */
export const CORPUS_WEIGHT_LOG_DATES: readonly string[] = daysBetweenInclusive(
  2026,
  4,
  1,
  2026,
  6,
  30,
)

/**
 * Slowly, monotonically decreasing by 50g/day starting at 82.00 kg on
 * 2026-04-01 — distinct at every step (`8200 - 5*index` cents, always an
 * exact multiple of 5, so `toFixed(2)` never rounds) — so a query that
 * resolves the wrong date range reports a visibly wrong number rather than a
 * coincidentally correct one.
 */
function weightKgAt(index: number): string {
  const cents = 8200 - 5 * index
  return (cents / 100).toFixed(2)
}

export const CORPUS_DAILY_WEIGHTS_KG: Readonly<Record<string, string>> = Object.fromEntries(
  CORPUS_WEIGHT_LOG_DATES.map((date, index) => [date, weightKgAt(index)]),
)

function weightAt(date: string): string {
  const weight = CORPUS_DAILY_WEIGHTS_KG[date]
  if (weight === undefined) throw new Error(`corpus fixture: no weight pinned for ${date}`)
  return weight
}

/** The pinned weight a "start of June" query must find (2026-06-01). */
export const CORPUS_START_OF_JUNE_WEIGHT_KG = weightAt('2026-06-01')
/** The pinned weight an "end of May" query must find (2026-05-25, the first day of that 7-day window). */
export const CORPUS_END_OF_MAY_WEIGHT_KG = weightAt('2026-05-25')
/** Adjacent to 2026-06-01: must NOT appear in a correct start-of-June answer. */
export const CORPUS_MAY31_WEIGHT_KG = weightAt('2026-05-31')
/** Dropped by the default (Europe/Rome) start-of-June window; picked up only once the window shifts later (Pacific/Niue). */
export const CORPUS_JUNE7_WEIGHT_KG = weightAt('2026-06-07')
/** Picked up only once the start-of-June window shifts later (Pacific/Niue); absent from the Europe/Rome and Pacific/Kiritimati answers. */
export const CORPUS_JUNE8_WEIGHT_KG = weightAt('2026-06-08')

function dateRange(fromDate: string, days: number): string[] {
  const startIndex = CORPUS_WEIGHT_LOG_DATES.indexOf(fromDate)
  if (startIndex === -1)
    throw new Error(`corpus fixture: ${fromDate} is not in the daily weight log`)
  return CORPUS_WEIGHT_LOG_DATES.slice(startIndex, startIndex + days)
}

/** The 7 calendar days a "start of June" query resolves to in `CORPUS_TIMEZONE` (Europe/Rome, UTC+2 in July). */
export const CORPUS_START_OF_JUNE_DATES = dateRange('2026-06-01', 7)
/** The 7 calendar days an "end of May" query resolves to in `CORPUS_TIMEZONE`. */
export const CORPUS_END_OF_MAY_DATES = dateRange('2026-05-25', 7)
/**
 * The same "start of June" query resolved in Pacific/Kiritimati (UTC+14):
 * a higher (more easterly) offset moves the window's UTC instant earlier, so
 * the window drops the last day (2026-06-07) and picks up the day before
 * (2026-05-31) relative to `CORPUS_START_OF_JUNE_DATES`.
 */
export const CORPUS_START_OF_JUNE_DATES_KIRITIMATI = dateRange('2026-05-31', 7)
/**
 * The same "start of June" query resolved in Pacific/Niue (UTC-11): a lower
 * (more westerly) offset moves the window's UTC instant later, so the window
 * drops the first day (2026-06-01) and picks up the day after
 * (2026-06-08) relative to `CORPUS_START_OF_JUNE_DATES`.
 */
export const CORPUS_START_OF_JUNE_DATES_NIUE = dateRange('2026-06-02', 7)

/**
 * Filler events on other topics (meals, walks): every date here is
 * deliberately outside 2026-05-25..2026-06-08 (see the module doc comment)
 * so it never perturbs a protected day's single-line source reference.
 */
const CORPUS_FILLER_EVENTS: readonly { at: string; text: string }[] = [
  { at: '2026-04-03T18:00:00.000Z', text: 'Cooked grilled salmon with asparagus for dinner' },
  { at: '2026-04-10T18:00:00.000Z', text: 'Went for a 5 km walk along the river' },
  { at: '2026-04-17T18:00:00.000Z', text: 'Made a big pot of minestrone soup' },
  { at: '2026-04-24T18:00:00.000Z', text: 'Took the dog for a long walk in the park' },
  { at: '2026-05-02T18:00:00.000Z', text: 'Grilled vegetables and quinoa for lunch' },
  { at: '2026-05-09T18:00:00.000Z', text: 'Went hiking on the coastal trail' },
  { at: '2026-05-16T18:00:00.000Z', text: 'Baked a loaf of whole grain bread for the week' },
  { at: '2026-06-12T18:00:00.000Z', text: 'Went for an evening jog around the block' },
  { at: '2026-06-19T18:00:00.000Z', text: 'Prepared a fresh salad with grilled chicken' },
  { at: '2026-06-26T18:00:00.000Z', text: 'Took a rest day and stretched at home' },
]

/**
 * The knowledge-update pair (issues/021-advanced-memory.md's "update"
 * category): two plain Events rather than FACTS entries, deliberately —
 * `SpacesEngine.writeFact` always stamps a fact's `noted` date from the
 * engine's own injected clock, which this suite pins to `CORPUS_NOW` for
 * every write, so two `writeFact` calls could never carry genuinely
 * different noted dates the way two Events with explicit, different `at`
 * values can. This is what gives "what is my current target weight?" a real,
 * date-ordered most-recent answer.
 */
export const CORPUS_TARGET_WEIGHT_OLDER = {
  text: 'My target weight is 75 kilograms',
  at: '2026-04-15T12:00:00.000Z',
}
export const CORPUS_TARGET_WEIGHT_NEWER = {
  text: 'My target weight is 73 kilograms',
  at: '2026-06-20T12:00:00.000Z',
}

/**
 * Recorded materially later than it occurred (20 days): the effective- vs
 * recorded-time check (issues/021-advanced-memory.md).
 */
export const CORPUS_SHOULDER_EVENT = {
  text: 'Started physical therapy for my shoulder',
  at: '2026-04-25T09:00:00.000Z',
  occurredAt: '2026-04-05T09:00:00.000Z',
}

/** The distinctive entity the fact-augmentation check searches for. */
export const CORPUS_READER_SUMMARY_SEARCH_TERM = 'medicenter'

interface CorpusReaderSummaryEvent {
  text: string
  at: string
  occurredAt: string
  origin: Origin
  payload: JsonObject
}

/**
 * A realistic `reader.summary` event (issues/021-advanced-memory.md's
 * fact-augmentation check): `payload.reader` matches
 * `quarantined-reader.ts`'s `ReaderOutputSchema` field-for-field (sender,
 * subject, intent, entities, deadlines, urgency, summary). Recorded three
 * weeks after the underlying email arrived — another materially-later
 * recorded-vs-occurred gap, distinct from `CORPUS_SHOULDER_EVENT`'s.
 */
export const CORPUS_READER_SUMMARY_EVENT: CorpusReaderSummaryEvent = {
  text: 'Quarantined reader classified an event from source "gmail"',
  at: '2026-06-10T09:00:00.000Z',
  occurredAt: '2026-05-20T14:30:00.000Z',
  origin: 'untrusted:gmail',
  payload: {
    queueId: 1,
    source: 'gmail',
    reader: {
      sender: 'dr.bianchi@medicenter-clinic.example',
      subject: 'Follow-up appointment confirmation',
      intent: 'meeting',
      entities: ['Dr. Elena Bianchi', 'Medicenter Clinic'],
      deadlines: ['2026-05-25T09:00:00.000+02:00'],
      urgency: 'normal',
      summary: 'Dr. Elena Bianchi confirmed your follow-up appointment at Medicenter Clinic.',
    },
  },
}

/** Two clearly-absent topics (issues/021-advanced-memory.md's abstention category): never mentioned anywhere else in this corpus. */
export const CORPUS_ABSENT_TOPICS: readonly string[] = ['chess tournament', 'scuba diving lessons']

/** The FACTS entries written through `SpacesEngine.writeFact`/`demoteFacts`, with the `noted` date every write actually receives. */
export interface CorpusFacts {
  /** Ends up active: the explicit refinement below supersedes `supersededText`. */
  activeText: string
  /** Ends up in `## Superseded` once the explicit refinement above lands. */
  supersededText: string
  /** Written active, then moved to `## Dormant` by an explicit `demoteFacts` call. */
  dormantText: string
  /** `SpacesEngine.writeFact` stamps every write with the engine's current day; this corpus pins that to `CORPUS_NOW`'s calendar day. */
  noted: string
}

export const CORPUS_FACTS: CorpusFacts = {
  activeText: 'I enjoy trail running less now that my knee hurts',
  supersededText: 'I enjoy trail running on weekends',
  dormantText: 'I keep a hydration log using a water tracking app',
  noted: CORPUS_NOW.slice(0, 10),
}

/**
 * Total events seeded, asserted by `memory-eval.test.ts`'s fixture-integrity
 * check: 1 Space-creation lifecycle event, 91 daily weight entries, 10
 * fillers, 2 target-weight events, 2 recorded-late events, 3 `fact.write`
 * echoes (one per `writeFact` call below, all non-noop), and 1 `fact.demote`
 * echo.
 */
export const CORPUS_EVENT_COUNT = 110

/**
 * Total bytes across every one of the Space's `*.jsonl` log files once fully
 * seeded (sum of `SpacesEngine.listLogFiles`' sizes) — asserted alongside
 * `CORPUS_EVENT_COUNT` so a fixture drift (a changed field, a reordered
 * write, a different redaction outcome) fails the fixture-integrity check
 * loudly instead of silently changing what the p95 latency test measures
 * against.
 */
export const CORPUS_LOG_BYTES = 14590

/** Seeds the full fixture described by this module's doc comment into a fresh Space. Deterministic; call once per fresh `SpacesEngine`. */
export function seedMemoryCorpus(engine: SpacesEngine): { spaceId: string; events: number } {
  const space = engine.createSpace({ name: 'Health', slug: CORPUS_SPACE_SLUG })

  for (const date of CORPUS_WEIGHT_LOG_DATES) {
    engine.appendEvent(space.id, {
      type: 'note',
      text: `weighed ${weightAt(date)} kg`,
      at: `${date}T10:00:00.000Z`,
    })
  }

  for (const filler of CORPUS_FILLER_EVENTS) {
    engine.appendEvent(space.id, { type: 'note', text: filler.text, at: filler.at })
  }

  engine.appendEvent(space.id, {
    type: 'note',
    text: CORPUS_TARGET_WEIGHT_OLDER.text,
    at: CORPUS_TARGET_WEIGHT_OLDER.at,
  })
  engine.appendEvent(space.id, {
    type: 'note',
    text: CORPUS_TARGET_WEIGHT_NEWER.text,
    at: CORPUS_TARGET_WEIGHT_NEWER.at,
  })

  engine.appendEvent(space.id, {
    type: 'note',
    text: CORPUS_SHOULDER_EVENT.text,
    at: CORPUS_SHOULDER_EVENT.at,
    occurredAt: CORPUS_SHOULDER_EVENT.occurredAt,
  })

  engine.appendEvent(space.id, {
    type: 'reader.summary',
    origin: CORPUS_READER_SUMMARY_EVENT.origin,
    text: CORPUS_READER_SUMMARY_EVENT.text,
    at: CORPUS_READER_SUMMARY_EVENT.at,
    occurredAt: CORPUS_READER_SUMMARY_EVENT.occurredAt,
    payload: CORPUS_READER_SUMMARY_EVENT.payload,
  })

  // Written in this order so the explicit refinement lands second and
  // supersedes the first: see `CorpusFacts`'s doc comment.
  engine.writeFact(space.id, CORPUS_FACTS.supersededText)
  engine.writeFact(space.id, CORPUS_FACTS.activeText, undefined, {
    supersedes: CORPUS_FACTS.supersededText,
  })
  engine.writeFact(space.id, CORPUS_FACTS.dormantText)

  const document = engine.readFacts(space.id)
  const ids = factRecordIds(document, CORPUS_FACTS.noted)
  const dormantCandidate = document.active.find((fact) => fact.text === CORPUS_FACTS.dormantText)
  const dormantId = dormantCandidate ? ids.get(dormantCandidate) : undefined
  if (dormantId === undefined) {
    throw new Error('corpus fixture: could not locate the dormant fact to demote')
  }
  engine.demoteFacts(space.id, [dormantId])

  const events = engine.readRecent(space.id, 100_000).length
  return { spaceId: space.id, events }
}
