# 105 — Undo accepted Character changes through the same decision flow

## Parent

- #99

## What to build

Let the user undo an accepted global or Space Character change without introducing a silent
rollback path. The owning workflow retains the accepted before/after revisions needed to prepare a
complete inverse replacement. “Undo” creates a new Pending decision with its own diff and requires
the same explicit confirmation, current-revision check, atomic write, authoritative outcome, and
Event-log record as every other Character change.

Manual edits and later accepted changes always win over stale history: undo must refuse or clarify
rather than overwrite a current document it cannot reconcile safely.

## Acceptance criteria

- [ ] The Character-change decision owner durably retains the complete before and after revisions
      required to prepare an inverse proposal for each accepted global and Space change.
- [ ] Full historical character content is protected like the live character document and never
      copied into Event entries, safe summaries, notifications, Runtime logs, or diagnostic Traces.
- [ ] An unqualified undo in global chat targets the latest applicable accepted `SOUL.md` change;
      an unqualified undo in focused-Space chat targets the latest accepted change for that Space.
- [ ] Explicit scope may select global identity or one named Space from either chat location under
      the same scope and ambiguity rules as #103.
- [ ] Missing history, multiple plausible targets, or ambiguous wording produces an explanatory
      response and no Pending decision or mutation.
- [ ] A valid undo prepares one new immutable Character-change decision containing the exact target,
      current starting revision, complete inverse document, and complete diff; it does not mutate
      the file while pending.
- [ ] Confirming a still-current inverse proposal replaces exactly one document atomically at most
      once and makes the restored character visible from the next applicable Agent call.
- [ ] A manual edit, later accepted change, competing client, duplicate confirmation, or stale
      current revision refuses safely and never overwrites newer content.
- [ ] Global undo appends safe revision metadata to the System Space Event log; Space undo appends
      only to the target Space's Event log.
- [ ] Rejecting or refining an undo follows the ordinary Character-change lifecycle and leaves the
      current document unchanged until a new proposal is explicitly accepted.
- [ ] Restart and reconnect preserve inverse proposals and terminal outcomes without duplicating
      writes or resurrecting resolved decisions.
- [ ] Integration tests cover global and Space undo, explicit and implicit scope, no history,
      ambiguity, manual edits, later changes, rejection, refinement, duplicate resolution, races,
      restart, Event logs, and the next captured system prompt.
- [ ] No separate history screen, arbitrary file restore operation, or bypass around the common
      Pending-decision contract is introduced.
- [ ] `pnpm check` passes.

## Blocked by

- #103
