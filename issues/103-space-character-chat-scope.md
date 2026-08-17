# 103 — Change a Space character safely from any chat scope

## Parent

- #99

## What to build

Extend the proven global Character-change journey to a Space's `INSTRUCTIONS.md` and make scope
selection consistent from either chat location. Focused-Space chat defaults to its own character;
explicit global language may still target `SOUL.md`, and global chat may target one explicitly named
Space through the narrow character capability only.

The same Agent keeps one global identity. Space character can specialize tone and constraints but
cannot introduce a local name, persona, product-policy override, or hidden multi-file write.

## Acceptance criteria

- [ ] An unqualified durable behavior request in focused-Space chat prepares one Character change
      for that Space's `INSTRUCTIONS.md` and leaves every other character document unchanged while
      pending.
- [ ] Explicit global scope from focused-Space chat targets `SOUL.md`; explicit selection of an
      existing Space from global chat targets only that Space's `INSTRUCTIONS.md`.
- [ ] Global chat gains only the read/propose capability for the explicitly selected character
      document and no general Space memory, Surface, Automation, or action authority.
- [ ] Scope ambiguity, a missing or multiply matched Space, and conflicting target language produce
      a clarifying response with no Pending decision and no file or Event-log mutation.
- [ ] A request for a Space-local name or identity is clarified or refused as local character; it
      can become a global proposal only after the user makes that global intent explicit.
- [ ] Space character may specialize global tone and communication constraints inside the target
      Space but cannot replace the global Agent name or override Gateway-owned policy.
- [ ] One proposal always targets exactly one document. A request spanning global and one or more
      Spaces becomes independent decisions whose acceptance and rejection do not affect one
      another.
- [ ] Each Space proposal carries its exact target, starting revision, complete replacement, and
      complete diff and uses the same stale, atomic, exact-once, restart, refinement, and
      authoritative-outcome contract as #102.
- [ ] A successful Space apply appends safe target and revision metadata to that Space's Event log
      and never to another Space; the next focused call receives the accepted local character.
- [ ] Global `SOUL.md`, non-target Space files, and non-target Event logs remain byte-for-byte
      unchanged throughout the focused journey.
- [ ] Proactive, Worker, external-event, Untrusted-content, replayed-session, and provider-native
      paths cannot create or resolve a Space Character change.
- [ ] The black-box fake-provider suite mirrors #102 through the real chat WebSocket and temporary
      filesystem, including focused default, explicit cross-location scope, ambiguity, multi-scope
      splitting, stale refusal, and the next captured focused system prompt.
- [ ] Behavior remains identical across Model connections.
- [ ] `pnpm check` passes.

## Blocked by

- #102
