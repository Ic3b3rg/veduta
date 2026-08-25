# 042 — Read Surface state and bind creation to the focused Space

## Context

The focused-Space Agent registry can create, patch, and archive Surfaces, but it cannot discover
which active Surfaces exist or read one before changing it. `patch_state` requires a Surface id and
operations shaped against its current typed state; `patch_tree` additionally requires the current
tree and `treeVersion`. Neither the assembled Space context nor any Agent tool provides those
inputs.

Creation has the inverse form of the same missing-scope problem. The focused registry already
offers `create_surface`, but its model-facing schema requires `spaceId`; the focused turn context
renders the Space name and slug, not its id. A model can sometimes recover the id from an existing
Surface or guess the current `spc-<slug>` convention, but an empty Space provides nothing to read
and that storage convention is not a model contract. A focused tool must derive its Space from the
turn rather than ask the model to repeat hidden routing state.

The Loopback profile hides this gap for meal logging because `mock-chat-model.ts` closes over
`Store`, looks up the fixed `srf-meals` id, and constructs a patch from state the model was never
given. A primary Model connection has no such side channel, so an otherwise valid request must
guess both identity and shape. Adding Surface data to every assembled context would make every turn
pay the token and trust cost for Surfaces it did not need.

The accepted cross-Space direction remains unchanged: a future global-chat turn will resolve and
enter the relevant Spaces itself rather than require manual navigation
([global multi-Space specification](136-global-chat-multi-space.md),
[ADR-0002](../docs/adr/0002-single-agent-spaces.md)). This issue provides the reusable Surface read
seam while keeping its current focused-Space model-facing contract narrow.

## Goal

Inside a focused Space, the Agent can discover every applicable Surface, read exactly the
declarative trees and typed state that back their visible UI, and then author protocol-valid
changes through the existing Surface tools. A single message may update multiple fields in one
Surface and multiple applicable Surfaces in that Space; every displayed summary, count, history,
or progress field that depends on the new information stays internally consistent. When no
Surface fits, the Agent can create one without knowing or supplying the focused Space id. Reads
preserve content origins so live taint continues to govern later actions. Natural-language
interpretation stays with the selected model; the Gateway gains no Surface-specific command
grammar or intent parser.

## What to build

- Add two provider-independent L0 tools to the focused-Space Agent registry:
  - `list_surfaces()` returns a deterministic compact inventory of the active Surfaces the Agent
    may author in that Space: `id`, `title`, `freshness`, and `pinned`. It does not return trees or
    state.
  - `read_surface({ surfaceId })` returns the complete `SurfaceSchema`-validated Surface plus its
    stored `version` and `treeVersion`. Its model-visible content must contain the structured tree
    and state, not leave them only in daemon-side `details`.
- Replace the focused registry's model-facing `create_surface` contract with a Space-bound wrapper:
  it keeps `id`, `title`, `tree`, `state`, `intent`, and `justification`, but exposes no `spaceId`.
  The wrapper injects the focused Space id and then delegates to the existing
  `gateCreateSurfaceTool` result, so Template matching, refusal, justified regeneration,
  validation, origin propagation, and Event log writes retain one implementation. An extra
  caller-supplied `spaceId` must never override the bound Space.
- Keep the raw Surface-engine creation operation explicitly Space-scoped for daemon callers and for
  the future global multi-Space registry. Do not teach `create_surface` to infer an id from a slug,
  derive it from another Surface, or duplicate the Template gate in the focused wrapper.
- Bind both tool handlers to the focused Space; their model-facing schemas carry no `spaceId`.
  Exclude archived Surfaces, the projected FACTS Surface, and daemon-owned Surfaces. A missing,
  excluded, or other-Space id fails with the same non-disclosing error and returns no content from
  the rejected Surface.
- Keep the underlying read operation explicitly Space-scoped and independent of the chat session,
  so the future global multi-Space registry can reuse it after resolving and entering a Space. Do
  not duplicate Surface resolution, validation, or origin handling in a chat-only handler.
- Return the origins of everything rendered to the model through `ToolResult.origins`:
  `read_surface` reports the target's stored `contentOrigin`; `list_surfaces` reports the
  deduplicated `contentOrigin`s of every listed Surface because their titles are model-visible.
  Reuse the existing whole-Surface origin mark. Per-field origins are not introduced.
- Let the existing `PiAgentRunner` machinery fold those reported origins into the turn's live
  taint and persist them with the tool result. A trusted turn that reads a Surface containing
  Untrusted content must make a later allowlisted L1 action produce an Approval card. Surface reads
  themselves and later L0 Surface changes remain free.
- Offer the new tools exactly once anywhere the existing focused-Space Surface registry is offered,
  and offer the Space-bound `create_surface` in place of its unbound form. Provider parameter
  schemas remain derived through the normal `ToolDef` path. Every eligible primary Model
  connection receives the same contract; no provider adapter executes or filters these tools
  specially.
- Tell focused turns to use the inventory as a complete affected-set check: read and update every
  applicable Surface in the current Space, and update every dependent bound state field needed to
  keep each Surface's visible content internally consistent. Do not add domain-specific dependency
  formulas to the Gateway; interpretation and patch construction remain model work over the
  model-visible trees and state.
- Do not add a Surface inventory to `SpacesEngine.assembleContext`. The Agent pays the context and
  origin cost only after choosing to call a reader.
- Keep current mutation concurrency semantics: `patch_state` remains last-write-wins and gains no
  `expectedVersion`; `patch_tree` continues to require its existing `expectedTreeVersion`.
- Replace the meal fixture's hidden state access with a deterministic model-tool exchange. A test
  model may be scripted to make the journey repeatable, but after receiving the user message it
  must discover the Surface id through `list_surfaces`, obtain the state through `read_surface`,
  and derive `patch_state` operations only from model-visible tool results. It must not import,
  close over, or call `Store` to answer the meal request.
- Keep natural-language understanding outside application logic. The required Italian utterance is
  one representative user input, not a command syntax; do not add a Meals-specific parser, fixed
  Surface id, or fixed state-shape branch to the Gateway or Surface engine.
- Update `ARCHITECTURE.md`'s Agent-tool and Surface-engine descriptions when the implementation
  lands. `CONTEXT.md` needs no change unless implementation introduces new domain language.

## Acceptance criteria

- [ ] **Discover, read, then patch:** a live focused-Space turn driven by a deterministic provider
      calls `list_surfaces`, selects a returned id, calls `read_surface`, and emits a valid
      `patch_state` derived from the returned state. The resulting Surface validates through
      `SurfaceSchema` and reaches the PWA through the existing Surface event stream.
- [ ] **Complete focused-Space update:** a message affecting multiple bound fields in one Surface
      updates all dependent visible values, and a message affecting two Surfaces in the focused
      Space reads and patches both before claiming completion. The Agent does not stop after the
      first matching title or first state operation; no domain-specific parser or fixed Surface id
      is added.
- [ ] **Create without guessing scope:** in a focused Space with no Agent-authored Surfaces, a
      deterministic provider receives a `create_surface` schema with no `spaceId`, calls it without
      one, and creates a protocol-valid Surface in that Space. Supplying an extra id for another
      Space cannot redirect the write. Template-match refusal and justified-regeneration tests
      prove the existing gate still runs against the bound Space and records its existing events.
- [ ] **Exact read contract:** `list_surfaces` returns only compact summaries in stable order;
      `read_surface` returns the complete current tree and state plus `version` and `treeVersion`.
      Neither tool accepts `spaceId`, injects inventory into assembled context, or returns an
      archived, projected FACTS, daemon-owned, or other-Space Surface.
- [ ] **Origins grow live taint:** starting from a trusted turn, read a Surface whose
      `contentOrigin` is untrusted and then call an otherwise allowlisted L1 tool. The read result's
      origins are persisted on the tool message and the action becomes an Approval card. The same
      sequence against a trusted Surface keeps the ordinary allowlist behavior.
- [ ] **End-to-end Meals scenario:** in the existing Local VPS browser journey, focus Health and
      send exactly `"aggiungi ai meals la fesa di tacchino"`. The deterministic model calls
      `list_surfaces → read_surface → patch_state`; the Meals Surface prepends
      `{ time: <local HH:mm>, meal: "fesa di tacchino" }`, sets `lastMeal` to
      `"fesa di tacchino"`, increments `mealCount`, and changes no Atom tree. The PWA visibly shows
      the new meal and updated summary, while the Space Event log records the user turn, ordered
      tool-call chain, and Surface patch.
- [ ] **No hidden state access:** the deterministic meal path has no `Store` access and no fixed
      `srf-meals` access. Unit coverage proves that its patch inputs came from the two tool results;
      production Gateway and Surface code contain no meal-language parser. The Italian sentence is
      a fixture, not the set of accepted phrasings for a real model.
- [ ] **Reusable isolation boundary:** direct tests cover an unknown id, a Surface in another
      Space, a daemon-owned Surface, and the projected FACTS Surface with the same non-disclosing
      failure. The underlying scoped reader can be reused without a chat-session dependency.
- [ ] **Registry parity:** tool-registry and parameter-schema tests assert both reader names appear
      once and `create_surface` exposes no `spaceId` in every focused-Space primary Model connection
      contract; all three remain absent from the current no-Space global registry. A documented,
      non-CI smoke with an eligible real Model connection creates a new Surface, then exercises the
      Italian request and a paraphrase without application changes.
- [ ] `pnpm check` passes, followed by the Local VPS browser e2e job that owns the Meals journey.

## Out of scope

- Global-chat Space resolution, cross-Space mutation, or requiring the user to navigate before
  future global work; the global multi-Space specification owns that flow.
- Creating or confirming a new Space; this issue only creates Surfaces inside an already focused
  Space.
- Reading projected FACTS or daemon-owned Surfaces through these tools.
- Per-field or per-state-key content origins.
- Optimistic concurrency for `patch_state` or other changes to mutation semantics.
- A natural-language command grammar, provider-specific prompt logic, or any Meals-specific
  production behavior.
- Giving Workers a Surface registry or changing their investigate-and-report boundary.

## Dependencies

Builds on completed issues 006, 007, 013, 014, 037, and 073. It has no open blocker; the global
multi-Space work may reuse this issue's internal scoped reader without changing its focused-Space
contract.
