import type { ReflectionDistillation, ReflectionDistiller, ReflectionInput } from './reflection.ts'

/**
 * Deterministic, zero-network stand-in for the Reflection's distillation
 * call (issue #21, docs/adr/0006-file-based-memory.md):
 * keyless dev profiles use a deterministic completion to exercise the nightly
 * sweep under `pnpm dev`. A selected real Model connection uses the live
 * tool-less bridge.
 *
 * To stay genuinely useful rather than a no-op, it derives real content from
 * the window it is handed: up to two summaries (an event count, and the
 * window's most frequent event type) and two insights, so a fresh dev
 * daemon's Nightly Reflection Surface shows the real shape of its Event
 * window without inventing durable facts.
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
    // Two, because issue #21 asks the Reflection for 2-3
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
    // room for itself. The mock Heartbeat uses the same discipline.
    return { summaries, insights, facts: [] }
  }
}
