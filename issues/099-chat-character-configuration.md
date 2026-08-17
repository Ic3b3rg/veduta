# 099 — Configure the Agent's identity and Space character through chat

## Problem Statement

Veduta has one global Agent identity in `SOUL.md` and a character document in each Space's
`INSTRUCTIONS.md`, but users cannot inspect or change either through the product. When asked whether
its tone can change permanently, the Agent currently suggests looking for settings that do not
exist. The chat also presents the product name as though it were necessarily the Agent's name.

The storage boundary is unsafe for user-controlled editing today. Default character documents mix
personality with Veduta-owned operating rules, the importer relies on that mixture, and neither
global nor focused-Space chat has a capability that can prepare a reviewable character change.
Adding a direct write tool would let model interpretation, stale context, or Untrusted content
silently replace durable instructions.

Users need a conversational way to give their single Agent a durable identity and to specialize
its behavior inside a Space, without creating per-Space personas, exposing a settings form, or
granting character text authority over safety and product mechanics.

## Solution

Make character configuration an entirely chat-driven workflow. `SOUL.md` remains the sole
free-form source of the Agent's global name, personality, baseline tone, and global character
preferences. Each `INSTRUCTIONS.md` remains the sole source of that Space's character and may
specialize tone or constraints without changing the Agent's identity. Veduta remains the product
name even when the Agent is renamed.

The Agent reads the applicable character document and prepares a complete replacement, but does
not write it. The Gateway registers one Character change as one Pending decision containing a safe
summary, exact target, starting revision, complete proposed content, and complete diff. Only an
authoritative user resolution may atomically apply it while the starting revision is still current.
The accepted change affects the next context assembled for its scope; an in-flight model call keeps
the context with which it started.

The first successful global-chat response on a fresh identity offers an optional two-question
Identity onboarding: how the Agent should be named and what kind of presence it should be. It does
not start an autonomous turn or block a substantive first request. Existing customized or imported
identities bypass the invitation.

## User Stories

1. As a Veduta user, I want Veduta to remain the product name, so that renaming my Agent does not rename or confuse the product.
2. As a new Veduta user, I want the Agent to begin with the default name Veduta, so that it has a usable identity before I configure it.
3. As a Veduta user, I want to rename my single Agent through chat, so that its identity feels personal to me.
4. As a Veduta user, I want to set the Agent's global personality and baseline tone, so that its behavior is consistent across Spaces.
5. As a Veduta user, I want to set global character preferences such as directness, warmth, or avoiding emoji, so that I do not repeat them in every Space.
6. As a Veduta user, I want to specialize tone and constraints inside one Space, so that the same Agent fits different life contexts.
7. As a Veduta user, I want a Space character to override global style only inside that Space, so that local needs do not alter other Spaces.
8. As a Veduta user, I want every Space to retain the Agent's one global name and identity, so that a Space never silently becomes another persona.
9. As a global-chat user, I want an unqualified character request to target the global identity, so that location supplies a useful default scope.
10. As a focused-Space user, I want an unqualified character request to target that Space's character, so that location supplies a useful default scope.
11. As a focused-Space user, I want an explicit request for a global change to override my current location, so that I can configure the Agent without navigating away.
12. As a global-chat user, I want an explicitly named Space character to be targetable without unlocking unrelated Space operations, so that explicit scope works consistently.
13. As a Veduta user, I want the Agent to ask when scope or intent is ambiguous, so that it does not guess which durable document I meant.
14. As a focused-Space user, I want a request for a local name or identity to be clarified instead of applied, so that Veduta preserves one Agent identity.
15. As a Veduta user, I want a capability question such as “Can I change your tone permanently?” to receive an explanation and a request for details, so that no empty or invented change is proposed.
16. As a Veduta user, I want a constraint on one output, such as a three-line summary, to remain a task constraint, so that ordinary work does not rewrite character.
17. As a Veduta user, I want a request about how the Agent should behave to become a durable Character change, so that there is no hidden temporary-personality mode.
18. As a Veduta user, I want character changes to originate only from my explicit current intent, so that the Agent cannot evolve itself autonomously.
19. As a Veduta user, I want email, web pages, documents, tool output, Automations, Workers, and quoted text to lack character-change authority, so that external instructions cannot reshape my Agent.
20. As a Veduta user, I want to see the exact target and complete diff before a character change, so that I understand what will be replaced.
21. As a Veduta user, I want the character document to remain unchanged while a proposal is pending, so that reviewing a suggestion has no side effect.
22. As a Veduta user, I want to reject a proposed change, so that the current character remains exactly as it was.
23. As a Veduta user, I want to request refinements to a proposal, so that I can review a newly generated diff before accepting it.
24. As a Veduta user, I want a simple “yes” to apply only the sole unambiguous pending proposal in scope, so that conversational confirmation remains safe.
25. As a Veduta user, I want multiple pending choices to trigger disambiguation with no mutation, so that a short reply cannot resolve the wrong decision.
26. As a Veduta user, I want a proposal to become stale when its target changes concurrently, so that confirmation never overwrites newer manual or Agent-assisted edits.
27. As a Veduta user, I want repeated confirmations or races with another client to apply a change at most once, so that retries are harmless.
28. As a Veduta user, I want the authoritative outcome reported in chat, so that model prose cannot claim an unapplied change succeeded.
29. As a Veduta user, I want an accepted character change to affect the next applicable Agent response without a restart or new chat, so that configuration feels immediate.
30. As a Veduta user, I want a model call already in progress to finish with its original context, so that a concurrent change cannot alter an executing turn unpredictably.
31. As a Veduta user, I want one proposal to target exactly one document, so that confirmation never hides a partial multi-file outcome.
32. As a Veduta user, I want a request spanning global and Space character to produce independent proposals, so that I can accept or reject each scope separately.
33. As a focused-Space user, I want every accepted `INSTRUCTIONS.md` change recorded in that Space's Event log, so that the Space has an observable history.
34. As a Veduta user, I want every accepted `SOUL.md` change recorded through the System Space, so that global identity changes are observable without a parallel audit system.
35. As a Veduta user, I want “undo the last character change” to create a reviewable inverse proposal, so that rollback is never silent or stale.
36. As a user who edits character files manually, I want my unrecognized prose preserved and concurrent edits detected, so that chat configuration does not seize ownership of my files.
37. As an upgrading user, I want only exact recognized Veduta-owned prompt blocks removed from character documents, so that migration never guesses which prose belongs to me.
38. As an importing OpenClaw or Hermes user, I want my adapted identity preserved and the Identity onboarding skipped, so that Veduta does not overwrite or second-guess imported character.
39. As a new user, I want the first successful global-chat response to invite a lightweight identity setup, so that the Agent gains character early without another wizard or form.
40. As a new user with an immediate task, I want the Agent to answer that task before briefly offering Identity onboarding, so that setup never blocks useful work.
41. As a new user, I want Identity onboarding to ask only how the Agent should be named and what kind of presence it should be, so that setup stays lightweight and does not collect my user profile.
42. As a new user, I want to skip or ignore Identity onboarding without being asked again, so that the optional invitation never becomes a nag.
43. As a new user, I want “decide for me” to produce a reviewable proposed identity, so that delegating the draft still does not authorize the write.
44. As a returning user, I want to change identity or Space character later with the same chat workflow, so that onboarding is not the only configuration opportunity.
45. As a user of any Model connection, I want the same character capabilities and safeguards, so that provider choice does not change Veduta behavior.
46. As a Veduta user, I want character text to remain subordinate to safety, trust, tools, memory, Space granularity, and Automation rules, so that personality cannot change product authority.
47. As a Veduta user, I want character configuration to remain entirely conversational, so that there is no separate settings screen or identity form to maintain.
48. As a Veduta user, I want pending and terminal Character changes to survive restart and reconnect, so that a crash cannot resurrect, lose, or duplicate a decision.

## Implementation Decisions

- Veduta has one Agent. `SOUL.md` is the only canonical global identity document and includes the
  user-chosen name, personality, baseline tone, and global character preferences. A Space's
  `INSTRUCTIONS.md` contains only that Space's character. No structured identity record,
  `IDENTITY.md`, database duplicate, profile, preset, or temporary overlay is introduced.
- New installations receive a clean user-controlled `SOUL.md` whose default Agent name is Veduta.
  Veduta-owned rules do not live inside either character document.
- The Gateway assembles safety, trust, tool-use, memory, Space-granularity, Automation, abstention,
  and other product rules outside the character documents. Existing duplicated rules are
  consolidated into one authoritative product-owned prompt boundary that remains effective in
  global and focused-Space contexts.
- Explicit scope beats chat location. Without explicit scope, global chat targets `SOUL.md` and
  focused-Space chat targets that Space's `INSTRUCTIONS.md`. An identity concept that cannot be
  local, a conflicting target, or any unresolved ambiguity produces a clarifying question and no
  Pending decision.
- Global chat gains only the narrowly scoped ability to read and propose a named Space's character;
  it does not gain general Space memory, Surface, Automation, or action tools.
- Agent-facing character operations expose the current target content and an opaque revision, then
  accept a complete proposed replacement against that revision. The Gateway, not the model,
  computes and retains the complete diff and validates that one proposal names exactly one existing
  target.
- Character operations are available only to interactive turns triggered by the current
  `trusted:user` message. Proactive work, Workers, external-event turns, Untrusted readers, and
  provider-native tools never receive this capability. Resolution authority remains exclusively in
  the current trusted user message through the common Pending-decision contract.
- Character change is a registered Pending-decision kind with apply and reject resolutions, a safe
  summary, global or Space ownership, target revision, complete proposed document, and truthful
  terminal outcomes. It reuses the lifecycle, exact-id resolution, restart recovery, and
  disambiguation established by issues #96, #97, and #98 rather than creating a parallel
  confirmation mechanism.
- Preparing a proposal never mutates a character document. Requesting a refinement terminates or
  supersedes the old proposal and creates a new immutable proposal; a resolved proposal is never
  edited in place.
- Apply uses compare-and-swap against the starting revision and an atomic file replacement. A stale
  revision refuses with no write and requires a fresh proposal. Competing or repeated resolutions
  return authoritative current state and cannot repeat the write.
- A request spanning multiple scopes is split into independent one-document proposals. A global
  character change never rewrites Space documents; a Space character continues to specialize the
  global baseline locally.
- The accepted global change appends safe revision metadata to the canonical System Space Event
  log; an accepted Space change appends to that Space's Event log. The decision owner retains the
  before/after revisions needed to prepare an inverse proposal without putting full character text
  in an Event entry. Undo is permitted only when the current revision can be reconciled safely and
  follows the same confirmation flow.
- Context is assembled afresh for every model call. A successful resolution is therefore visible
  from the next applicable call; no running call is retroactively modified and no process or
  session restart is required.
- Identity onboarding is an installation-wide, one-time invitation in the Agent's first successful
  global-chat response while the identity is still pristine and no prior invitation was completed
  or offered. It never creates an autonomous turn. A substantive first request is answered before
  the brief invitation; a greeting may receive the invitation as the main response.
- Identity onboarding asks two conversational questions in sequence: the Agent's name, then the
  kind of presence the user wants, including optional role, personality, tone, and communication
  preferences. It synthesizes one ordinary `SOUL.md` proposal and uses the same Pending-decision
  flow. “Decide for me” authorizes drafting only, never applying.
- The one-time onboarding state is daemon-owned and durable rather than browser-local. A failed
  first turn does not consume the invitation. Once a successful response offers it, ignoring or
  declining it prevents automatic re-prompting; later explicit character requests always remain
  available. A customized or imported `SOUL.md` bypasses the invitation.
- Upgrade migration removes only byte-for-byte recognized Veduta-owned legacy blocks and templates
  from `SOUL.md` and `INSTRUCTIONS.md`. Unknown, reordered, or customized prose is preserved. No
  model classifies likely product text during migration.
- Import adaptation keeps its redaction, delimiter neutralization, complete preview, backup, and
  conflict protections, but no longer prepends product rules inside imported `SOUL.md`. Existing
  adapted personality remains user-controlled and subordinate to the separately assembled Gateway
  policy.
- Existing non-blocking character-document size warnings remain applicable. The feature does not
  invent a new hard character limit or truncate a proposal silently.
- The feature presents proposal details and outcomes in ordinary chat. It adds no dedicated
  settings view, configuration Surface, or identity label dependency.

## Testing Decisions

- The primary seam is a black-box Gateway chat integration using the real WebSocket protocol, a
  real temporary filesystem, the real Spaces engine and Pending-decision repository, persistent
  sessions, and the deterministic fake provider established by issue #37. Tests assert external
  frames and durable state, not helper calls or internal object shape.
- The global journey sends a trusted request to rename the Agent and change its tone, has the fake
  provider prepare the Character change, verifies that `SOUL.md` is unchanged while pending,
  resolves it through chat, and verifies exactly one atomic write plus a System Space Event. The
  next turn's captured system prompt must contain the accepted identity while product-owned policy
  remains outside the file.
- The same contract is exercised in focused-Space chat: only the target `INSTRUCTIONS.md` and its
  Event log change, `SOUL.md` and other Spaces remain unchanged, and the next focused turn receives
  the local character.
- The high-seam suite covers rejection, refinement, duplicate confirmation, competing clients,
  restart/reconnect recovery, a manually changed target revision, stale refusal, and an inverse
  proposal. Every path asserts zero mutation before acceptance and at most one mutation afterward.
- Scope tests cover global and focused defaults, explicit scope overriding location, a named Space
  from global chat, global identity language inside a Space, impossible local identity, multi-scope
  splitting, missing Space, and ambiguity producing no proposal.
- Trust tests prove that proactive, Worker, external-event, Untrusted-content, replayed-session, and
  provider-native paths cannot create or resolve Character changes. A current trusted-user request
  and a later explicit resolution are both required.
- Context-assembly tests prove that all known product-owned rules are injected independently of
  character, exactly once where applicable, and cannot be removed by replacing `SOUL.md` or
  `INSTRUCTIONS.md`.
- Migration tests use untouched legacy defaults, each known legacy block independently, customized
  prose around known blocks, reordered or near-match text, imported identities, empty files, and
  repeat execution. Only exact known text is removed, unknown bytes remain unchanged, and rerunning
  migration is idempotent.
- Importer tests preserve the existing full-preview, secret-redaction, delimiter-neutralization,
  refusal, and backup corpus while proving imported personality is no longer coupled to embedded
  Veduta policy.
- Identity-onboarding tests cover a greeting, a substantive first request, a model failure followed
  by retry, accept, ignore, explicit skip, “decide for me,” restart, a customized identity, and an
  imported identity. The invitation appears in at most one successful global response and never in
  a focused-Space or autonomous turn.
- A small model-behavior evaluation corpus should include the motivating Italian-style capability
  question, durable character directives, one-output constraints, explicit global/local language,
  and ambiguous phrasing. It is diagnostic rather than a deterministic CI gate: safety rests on
  proposal visibility and daemon-owned confirmation, not on predicting every natural-language
  formulation.
- Existing fake-provider chat streaming, Spaces context, importer, trust-matrix, onboarding, atomic
  persistence, and Pending-decision race tests are the prior art. No browser E2E is required unless
  implementation changes chat rendering beyond its existing text stream.
- `pnpm check` remains the completion gate for every implementation ticket, with the black-box
  journeys run in the relevant package suite.

## Out of Scope

- Redesigning chat layout, message bubbles, speaker labels, colors, or removing the currently
  hardcoded displayed name. That work belongs to the planned full UI rework.
- A dedicated identity, personality, or Space-character settings screen or Surface.
- Per-Space Agent names, personas, separate Agents, Agent hierarchies, profiles, or isolated
  workspaces.
- Structured identity fields, an `IDENTITY.md` document, parsing a name for display elsewhere, or
  duplicating character data in a database.
- Personality presets, slash commands, session overlays, temporary personalities, or autonomous
  Agent self-evolution.
- Collecting or editing the user's profile in `USER.md` during Identity onboarding.
- Changing safety, trust, tool, memory, Space, Automation, or other Gateway-owned product rules
  through character configuration.
- General multi-Space work from global chat; only the narrow character-document capability is added.
- Replacing or redesigning the common Pending-decision framework and its cross-channel outcome
  delivery, which are owned by issues #96, #97, and #98.
- A hard size cap or automatic model-authored cleanup of existing custom character documents.

## Further Notes

- ADR-0018 records the architectural boundary and amends ADR-0006's placement of abstention policy
  and ADR-0010's imported-SOUL defense. The canonical terms Character change and Identity onboarding
  are defined in `CONTEXT.md`.
- OpenClaw separates voice in `SOUL.md`, structured metadata in `IDENTITY.md`, and operating rules in
  `AGENTS.md`, and supports multiple isolated Agents. Hermes keeps a global `SOUL.md` plus a selected
  personality overlay and fully separate profiles. Veduta adopts the useful policy/character
  separation while deliberately retaining one Agent, one free-form global identity, Space-local
  character, no overlay, and no autonomous rewrite.
- The referenced unofficial OpenClaw blog describes configuration paths and keys that do not match
  the current official repository; official source documentation remains authoritative.
- Issue #32's existing non-blocking warnings for large human-authored character documents remain
  relevant. Issue #63 should be coordinated with the System Space audit event, but this feature must
  not introduce another global audit namespace or a bespoke system UI.

## Blocked by

- #96
- #97
- #98

## Implementation tickets

- #100 through #105.

## Parent completion criteria

- [ ] Issues #100 through #105 are complete.
- [ ] Global identity and Space character changes share the Pending-decision lifecycle without
      moving product-owned rules into user-controlled documents.
- [ ] The full repository gate and owning browser E2E are green.
