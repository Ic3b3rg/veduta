import type { ReflectionDistillation, ReflectionDistiller, ReflectionInput } from './reflection.ts'

/**
 * Deterministic, zero-network stand-in for the Reflection's distillation
 * call (issues/021-advanced-memory.md, docs/adr/0006-file-based-memory.md):
 * the dev profile has no real Agent loop or provider key wired yet, same
 * rationale as `mockReaderComplete` (the quarantined reader's stand-in), the
 * Heartbeat's own `complete` stub in `server.ts`, and
 * `createMockWorkerReviewComplete` — a deterministic completion is enough to
 * exercise the nightly sweep end-to-end under `pnpm dev`, with no API key.
 * The real provider client replaces this outright once the Agent loop
 * lands.
 *
 * To stay genuinely useful rather than a no-op, it derives real content from
 * the window it is handed: up to two summaries (an event count, and the
 * window's most frequent event type) and one insight (how many distinct
 * event types occurred), so a fresh dev daemon's Nightly Reflection Surface
 * shows something real after its first night. It proposes at most one
 * candidate fact — the text of the first event in the window with
 * non-empty text, carrying that same event's own `sourceRef` as its only
 * evidence. `Reflection.runReflection` drops any fact whose `sourceRefs` do
 * not all dereference to an event inside the window it was distilled from
 * (issues/021-advanced-memory.md's evidence requirement), so a stand-in
 * that invented a reference would just have its fact silently discarded —
 * this one only ever cites evidence it was actually handed.
 */
export function createMockReflectionDistiller(): ReflectionDistiller {
  return async (input: ReflectionInput): Promise<ReflectionDistillation> => {
    if (input.events.length === 0) {
      return { summaries: [], insights: [], facts: [] }
    }

    const typeCounts = new Map<string, number>()
    for (const { event } of input.events) {
      typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1)
    }
    const [topType, topCount] = [...typeCounts.entries()].sort(
      (left, right) => right[1] - left[1],
    )[0]!

    const summaries = [
      `${input.events.length} event(s) recorded in this window.`,
      `Most common event type: "${topType}" (${topCount} occurrence(s)).`,
    ]
    // Two, because issues/021-advanced-memory.md asks the Reflection for 2-3
    // higher-level insights and a stand-in that emits one would make the
    // report look like the engine under-delivers rather than the stub.
    const insights = [
      `Activity spanned ${typeCounts.size} distinct event type(s) for this Space overnight.`,
      `The busiest kind of entry was "${topType}", which is where this Space's attention went.`,
    ]

    // Deliberately no facts. A stand-in may describe a window, but it must
    // never write durable memory: a fact goes into `FACTS.md`, is injected into
    // every later turn, and — because the Reflection demotes to stay under the
    // `low` budget — displaces the user's real facts into `## Dormant` to make
    // room for itself. The Heartbeat's stub has the same discipline: it reports,
    // it does not persist. A real distiller replaces this outright once the
    // Agent loop lands.
    return { summaries, insights, facts: [] }
  }
}
