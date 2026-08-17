# 093 — Bind focused Automation tools to the active Space and enforce ownership

## Context

The focused-Space chat registry exposes the raw Scheduler tools. Their model-facing schemas require
the internal `spaceId`, even though focused turn context exposes only the Space name and slug. A
model therefore has to guess storage identity; passing `personal` for the Personal Space fails.

The same raw registry accepts a globally unique numeric Automation id for cancellation without
checking that it belongs to the focused Space. It also exposes no compact model-facing inventory
or enabled-state mutation, so a request such as “disable all Automations here” cannot reliably
discover and update the complete affected set.

[Issue 042](042-surface-read-tools.md) establishes the equivalent focused-Space binding and
discovery pattern for Surface tools. Automation tools need the same ownership boundary before
their shared contract is copied into subscription-backed turns.

## Goal

Focused turns receive a Space-bound Automation registry. Model-facing creation schemas omit
`spaceId`; handlers inject the active Space. The Agent can list the complete affected set and set
the enabled state idempotently. Read and mutation operations reject unknown, inapplicable, or
other-Space ids through one non-disclosing error. Raw Scheduler APIs retain explicit scope for
daemon-owned callers and future global multi-Space orchestration.

## What to build

- Build the focused Automation tool set with the active Space id already bound.
- Add `list_automations()` as a deterministic compact inventory of every non-cancelled Automation
  in the focused Space. Return the id, kind, description, enabled state, status, and schedule or
  next occurrence needed for management decisions.
- Preserve the existing `arm_timer` and `create_job` scheduling inputs except that their
  model-facing schemas expose no `spaceId`. Extra model input cannot redirect either write.
- Expose an idempotent enabled-state mutation that accepts an Automation id and explicit boolean,
  delegates to the existing Scheduler toggle semantics, and refreshes the Automations Surface.
- Restrict cancellation and enabled-state mutation to Automations owned by the bound Space.
  Unknown and other-Space ids return the same non-disclosing failure and cause no read, mutation,
  or Event in either Space.
- Keep raw daemon Scheduler operations explicitly Space-scoped or ownership-aware. Do not infer an
  internal id from a Space name, slug, Surface id, or storage convention.
- Preserve origins, trust decisions, conditions, handler-driven Automations, catch-up behavior,
  persistence, Event-log mutations, and Surface projection behind the existing implementations.
- Offer the focused tool set exactly once wherever focused Surface and memory tools are offered.
  Global chat continues to receive no Space tools.
- Make every eligible primary Model connection receive the same provider-independent parameter
  schemas and behavior. Subscription parity work must exercise this corrected contract.

## Acceptance criteria

- [ ] In a focused Space, timer and recurring-Automation definitions expose no `spaceId`; valid
      calls create Automations in that Space and cannot be redirected by extra model input.
- [ ] `list_automations()` returns only non-cancelled Automations owned by the focused Space in a
      stable order, with enough compact state to handle “disable all Automations here” without
      reading SQLite, Surface internals, or another Space.
- [ ] Setting `enabled` to an explicit boolean is idempotent, updates the existing Automations
      Surface, and records the existing `automation.toggle` Event exactly once when state changes.
- [ ] Cancel, toggle, and any single-Automation read reject an unknown or other-Space id with the
      same non-disclosing result and cause no mutation or Event in either Space.
- [ ] Raw daemon-owned creation and scheduling flows retain explicit Space scope and current
      handler, origin, condition, catch-up, persistence, and Surface-projection behavior.
- [ ] Focused registry tests prove every Automation tool appears exactly once, global chat still
      receives none, and parameter schemas are provider-independent across eligible Model
      connections.
- [ ] An integration test reproduces the Personal-Space failure using only model-visible inputs,
      then proves creation, list, disable-all, and cancellation work without exposing or guessing
      the internal Space id.
- [ ] Issue 077's parity fixtures exercise the corrected shared contracts rather than the raw
      unbound schemas.
- [ ] `pnpm check` passes.

## Out of scope

- Resolving or mutating multiple Spaces from global chat.
- Changing what a generic recurring Automation executes when it becomes due.
- External URL reading, article summarization, or provider-native web search.
- Redesigning the Automations Surface.

## Blocked by

None — can start immediately. This issue blocks #77.
