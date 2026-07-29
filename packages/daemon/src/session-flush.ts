import type { ContextPolicy, ContextPolicyContext, SessionMessage } from './agent-runner.ts'
import { effectiveOrigin, type Origin } from './taint.ts'

/**
 * Pre-compaction session flush (issue #21): the silent turn that persists
 * whatever a session holds that has not been saved yet, run immediately
 * before a `ContextPolicy` compacts a session's messages away.
 *
 * This module is a wired, tested seam, not live behaviour. The daemon has
 * no compaction policy today — it runs `disabledContextPolicy`
 * (`agent-runner.ts`), which never calls `ContextPolicyContext.beforeCompact`
 * — so `withPreCompactionFlush` and `createFactFlush` are not wired into
 * `server.ts`. They exist so that the day a real compacting `ContextPolicy`
 * ships, it only has to call the hook it already receives; nothing about
 * the flush contract needs to change.
 */

/**
 * The silent turn itself: given the messages a `ContextPolicy` is about to
 * compact away, persist whatever they hold that is not already saved.
 * Runs at most once per `transform` call, via `withPreCompactionFlush`.
 */
export type PreCompactionFlush = (
  messages: SessionMessage[],
  context: ContextPolicyContext,
) => Promise<void>

/**
 * Wraps a compacting `ContextPolicy` so `flush` runs before the policy
 * compacts, without requiring the policy to know about flushing at all —
 * it only has to honour the `beforeCompact` contract it already receives.
 *
 * Fails closed: if `flush` rejects, the error is logged (the pattern
 * `scheduler.ts` uses for a background failure it cannot surface to a
 * caller) and this returns the **untransformed input `messages`**.
 * Compacting after failing to persist what the session holds would destroy
 * exactly the content the flush was trying to save — destructive forgetting
 * is one of this project's anti-requirements (`ARCHITECTURE.md` §7), so a
 * broken flush must block compaction rather than let it through unsaved.
 *
 * That guarantee does not rely on the policy behaving. `beforeCompact` runs
 * inside the policy's own `transform`, so the decorator cannot stop a
 * transform already in progress; what it can do is refuse to *return* its
 * result. A recorded flush failure therefore always wins: the wrapper waits
 * for the flush's outcome after `transform` settles — whatever the policy
 * did with the rejection, including swallowing it or never awaiting it at
 * all — and discards the policy's output if the flush failed. Awaiting it
 * also means a policy that starts the hook and walks away cannot leave an
 * unhandled rejection behind.
 *
 * A `transform` rejection for any other reason (a bug in the policy, an
 * aborted signal, ...) is not a flush failure and propagates unchanged.
 */
export function withPreCompactionFlush(
  policy: ContextPolicy,
  flush: PreCompactionFlush,
): ContextPolicy {
  return {
    enabled: policy.enabled,
    async transform(messages, context) {
      // The flush runs at most once per transform, and `attempt` is the
      // promise every `beforeCompact` call shares, so a policy that calls the
      // hook twice awaits the same single run.
      let attempt: Promise<void> | undefined
      let flushFailure: { error: unknown } | undefined

      const beforeCompact = (): Promise<void> => {
        attempt ??= (async () => {
          try {
            await flush(messages, context)
          } catch (error) {
            flushFailure = { error }
            throw error
          }
        })()
        return attempt
      }

      let transformed: SessionMessage[] | undefined
      let transformFailure: { error: unknown } | undefined
      try {
        // A copy, so discarding the policy's return value is enough to undo it.
        // Handed the caller's own array, a policy could splice it in place and
        // the compaction would survive being "discarded" below.
        transformed = await policy.transform([...messages], { ...context, beforeCompact })
      } catch (error) {
        transformFailure = { error }
      }

      // Settle the flush before deciding anything: the policy may have
      // swallowed its rejection, or started it without awaiting.
      if (attempt !== undefined) await attempt.catch(() => undefined)

      if (flushFailure !== undefined) {
        console.error('pre-compaction session flush failed', flushFailure.error)
        return messages
      }
      if (transformFailure !== undefined) throw transformFailure.error
      return transformed ?? messages
    },
  }
}

export interface FactFlushOptions {
  writeFact: (fact: string, origin: Origin) => void
  extractFacts: (messages: SessionMessage[]) => Promise<string[]> | string[]
}

/**
 * The default silent turn: extract durable facts from the messages about
 * to be compacted away and write each one. The origin stamped on every
 * fact is the session's `effectiveOrigin` — most-untrusted-wins over every
 * message's `origin` (`docs/SECURITY.md §3.2`), falling back to
 * `'trusted:system'` for a session that never saw untrusted content —
 * because a session that read untrusted input must not be able to launder
 * it into a clean, trusted fact just by flushing before compaction.
 *
 * Errors from `extractFacts` propagate uncaught so `withPreCompactionFlush`
 * can apply its fail-closed path. Deduplication is deliberately not this
 * function's job: the Curator's Noop step already drops facts that are
 * already saved.
 */
export function createFactFlush(options: FactFlushOptions): PreCompactionFlush {
  return async (messages, _context) => {
    const facts = await options.extractFacts(messages)
    const origin = effectiveOrigin(
      messages.map((message) => message.origin),
      'trusted:system',
    )
    for (const fact of facts) {
      options.writeFact(fact, origin)
    }
  }
}
