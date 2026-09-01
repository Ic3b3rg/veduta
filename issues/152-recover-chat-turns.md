# 152 — Recover live and interrupted turns with explicit Retry

## Parent

#141 — [Persist one Chat timeline per Chat scope](https://github.com/Ic3b3rg/veduta/issues/141)

Canonical specification: [issues/141-durable-chat-timelines.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/141-durable-chat-timelines.md)

## What to build

Make accepted, live, and interrupted Chat turns recoverable without replaying user intent implicitly. Persist the visible turn lifecycle, reconnect a reloaded PWA to the same running turn, resume accepted work that never started exactly once, and convert work that had started before a Gateway crash into an explicit `Interrupted` terminal state. The user may then choose `Retry`, which starts a newly identified turn linked to the interrupted one.

Recovery must converge across clients and preserve scope. It must never automatically repeat Agent execution or external effects merely because a connection or process restarted.

## Acceptance criteria

- [ ] An accepted turn has stable identity, Chat scope, and a durable visible lifecycle that distinguishes accepted, running, completed, failed, and interrupted outcomes.
- [ ] Accepted submissions execute in acceptance order within one Chat scope; different Chat scopes may execute in parallel.
- [ ] One Chat scope admits at most eight accepted, nonterminal submissions. A ninth submission is not accepted or executed, and remains visibly available in the PWA for retry without preventing another scope from accepting work.
- [ ] Reloading or reconnecting while the Gateway still owns a running turn reattaches to that same turn and continues its visible updates without resubmission.
- [ ] Repeated subscriptions and reconnects cannot duplicate the user entry, execution, Pending feedback, or terminal result.
- [ ] On startup, the Gateway resumes accepted-but-not-started work exactly once and deterministically marks orphaned running turns as `Interrupted` after establishing that their execution cannot resume.
- [ ] An interrupted entry explains that completion is unknown and offers an explicit, accessible `Retry` action.
- [ ] `Retry` creates a new turn identity linked to the interrupted turn and never rewrites the original history.
- [ ] No reconnect, reload, timeout, or Gateway restart automatically replays Agent execution or external effects.
- [ ] Retry submission is idempotent, and the PWA prevents accidental repeated activation while its result is pending.
- [ ] Two connected clients converge on running, interrupted, retried, and terminal states in the correct Chat scope.
- [ ] Every connected client converges on accepted/running state and the final outcome; transient token deltas normally target the originating client and are not replayed after reconnect.
- [ ] Execution traces and low-level recovery details remain outside the visible Chat timeline.
- [ ] Gateway and PWA tests cover live reload, dropped connections, accepted-before-start recovery, running-turn interruption, repeated reconnect, explicit retry, duplicate retry, the per-scope capacity boundary, and two-client convergence.
- [ ] A browser test proves both live-turn reattachment and crash-to-Interrupted-to-Retry behavior.
- [ ] `pnpm check` passes.

## Blocked by

- #151
