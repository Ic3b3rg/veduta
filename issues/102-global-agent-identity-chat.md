# 102 — Change the global Agent identity safely from chat

## Parent

- #99

## What to build

Deliver the first complete Character-change journey for the global Agent identity. A current
trusted user request in global chat can read the current `SOUL.md`, prepare a complete replacement,
and show its target and diff, but cannot write it. The Gateway owns a Character-change Pending
decision and applies the replacement atomically only after authoritative chat resolution against
the still-current revision.

The accepted identity must be visible from the next Agent call, be recorded through the System
Space, and remain subordinate to the Gateway-owned policy from #100. No settings screen or general
global-chat Space capability is part of this slice.

## Acceptance criteria

- [ ] Global chat exposes narrowly scoped operations to read the current global character with an
      opaque revision and to prepare one complete `SOUL.md` replacement against that revision.
- [ ] A current `trusted:user` request can register a global Character-change Pending decision with
      a safe summary, exact target, starting revision, complete proposed content, and complete diff.
- [ ] Preparing, refining, rejecting, or merely discussing a proposal leaves `SOUL.md` byte-for-byte
      unchanged.
- [ ] Requesting refinement terminates or supersedes the prior proposal and produces a new immutable
      decision; resolved decisions are never edited in place.
- [ ] Applying delegates through the common Pending-decision owner, validates the starting revision,
      and replaces `SOUL.md` atomically at most once.
- [ ] A manual edit, competing accepted change, duplicate confirmation, repeated message, or race
      with another client cannot overwrite newer content or repeat the write; stale state is
      reported authoritatively and requires a fresh proposal.
- [ ] A bare apply or reject works only for the sole unambiguous visible decision under #98; multiple
      candidates change nothing until the user identifies one.
- [ ] Successful apply appends safe target and revision metadata to the canonical System Space
      Event log without copying the full character document into the event.
- [ ] The first Agent call assembled after success contains the accepted identity, name, tone, and
      preferences; an already-running call retains its original context and no restart is required.
- [ ] Empty or contradictory character content cannot suppress the separately assembled
      Gateway-owned policy.
- [ ] Proactive work, Workers, external-event turns, Untrusted readers, provider-native tools, and
      model-authored assertions cannot create or resolve this decision. Only explicit intent in the
      current trusted user turn receives proposal capability, and resolution requires a later
      explicit trusted user message.
- [ ] Capability questions and single-output constraints do not create a decision; a request about
      durable Agent behavior does. Ambiguous intent asks a question and changes nothing.
- [ ] Pending and terminal state plus authoritative outcomes survive restart and reconnect without
      resurrection or duplicate feedback.
- [ ] The black-box fake-provider test drives the real chat WebSocket, persistent session,
      filesystem, Pending-decision repository, and System Space Event log from request through the
      next captured system prompt.
- [ ] The same behavior and safeguards are available through every Model connection via the shared
      Agent tool path.
- [ ] `pnpm check` passes.

## Blocked by

- #101
- #98
