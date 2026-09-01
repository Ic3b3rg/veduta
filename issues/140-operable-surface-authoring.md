# 140 — Make every accepted Surface visibly operable

## Problem Statement

Veduta can currently accept and persist a Surface whose Atom tree is structurally valid while its
declared meaning is not implemented by the catalog. Atom props are mostly arbitrary JSON, bindings
are checked only for key existence, and renderers silently ignore unsupported props, action names,
or bound value shapes. A Surface tool can therefore report success and the Agent can claim that the
Home changed even though the PWA renders an empty card, an inert control, a missing chart, or an
unchanged Surface presentation.

The confirmed regressions are deliberately generic rather than domain-specific: a requested gym
plan produced only an empty Surface card, a 74 kg measurement was persisted without changing the
visible Weight Tracker, text controls could not be edited usefully, and a request for a full-row
Surface was accepted without changing its placement. Existing Surface authoring, validation,
persistence, and realtime tests all passed, showing that the missing contract lies across the
protocol, catalog, Surface engine, Agent tools, and PWA host rather than in one vertical feature.

## Solution

Make protocol acceptance mean that a Surface is visibly renderable and, where interactive,
operable. Every v1 Atom receives one strict semantic contract covering its props, allowed children,
binding requirements and bound value shape, and action requirements. The catalog consumes that
same contract without silent interpretation gaps, and every complete Surface is validated before
creation, recomposition, state mutation, Template reuse, persistence, or rendering.

Text entry uses a local Form draft and submits once, rather than mutating durable state on each
keystroke. Chart v1 has an explicit one-series line or bar contract. Surface presentation becomes
typed Surface metadata with only `standard` and `full` in v1, independent of the Atom tree and Pin.
The Agent chooses the initial presentation from the content and may change it later only in response
to an explicit user request.

Invalid or unsupported authoring fails before persistence with an actionable tool result. The Agent
may correct and retry during the same turn, but its final reply must describe the authoritative
committed result and must never claim that the UI changed when no valid mutation committed.

## User Stories

1. As a Veduta user, I want a newly created Surface to contain visible useful content, so that a successful chat response never leaves me with an empty card.
2. As a Veduta user, I want a recorded weight measurement to appear in the Weight Tracker immediately, so that chat and the visible Surface agree.
3. As a Veduta user, I want a weight chart to use the same committed measurements as its visible records, so that summaries and visual trends cannot diverge.
4. As a Veduta user, I want a requested three-day gym plan to render its days, exercises, sets, repetitions, recovery, progression, and caveats, so that the Surface is useful after the chat turn ends.
5. As a Veduta user, I want text controls to accept normal typing, so that I can prepare an edit without fighting a controlled value that resets.
6. As a Veduta user, I want text edits to remain local until I submit the Form, so that every keystroke does not create durable state, Event log noise, or Agent work.
7. As a Veduta user, I want one Form submission to carry the complete current draft, so that related fields are applied coherently.
8. As a Veduta user, I want failed Form submission to preserve my draft and show a readable error, so that I can correct or retry without retyping.
9. As a Veduta user, I want a Surface requested as full-row to visibly span the available Space row, so that presentation requests have an observable effect.
10. As a Veduta user, I want `standard` and `full` presentation to survive reload, reconnect, and Gateway restart, so that placement is living state rather than a transient client preference.
11. As a Veduta user, I want the Agent to change Surface presentation only when I explicitly request it, so that ordinary state updates and Automations do not unexpectedly rearrange my Space.
12. As a Veduta user, I want Pin and Surface presentation to remain independent, so that prominence does not silently change a Surface's placement or content contract.
13. As a Veduta user, I want malformed or unsupported Surface authoring to leave the previous valid Surface intact, so that one bad model call cannot replace useful content with a partial result.
14. As a Veduta user, I want the Agent to state plainly when Surface authoring failed or became a Tree proposal, so that chat never reports an effect that did not commit.
15. As a Veduta user on two authenticated devices, I want both clients to converge on the same content and presentation, so that one device does not show a different interpretation of the Surface.
16. As a keyboard or assistive-technology user, I want every accepted interactive Atom to expose a usable labelled control and submit behavior, so that protocol validity includes operability.
17. As a user of any primary Model connection, I want the same Surface contract and outcomes, so that BYOK and subscription connections cannot author different capability subsets.
18. As a contributor, I want adding or changing an Atom to require a complete schema, renderer, interaction fixture, and rejection fixture, so that semantic gaps cannot re-enter the catalog.
19. As a contributor, I want a known but unavailable renderer to remain visibly represented by `UnknownAtom`, so that client-version skew never crashes a Space or makes content disappear.
20. As an operator, I want clean-data verification to prove the visible result rather than inspect only stored JSON, so that green tests correspond to the experience users actually receive.

## Implementation Decisions

- Replace the generic Atom semantic boundary with a discriminated contract for every v1 Atom type.
  Each contract defines allowed and required props, child cardinality, whether a binding is allowed
  or required, the accepted bound value shape, and the allowed and required actions. Unknown props,
  misspelled actions, impossible child structures, and incompatible bound values are validation
  errors rather than ignored input.
- Keep one catalog and one protocol contract. The catalog must render or operate every behavior the
  protocol accepts; it must not maintain a looser private interpretation. Adding an Atom behavior is
  incomplete until validation and rendering land together.
- Validate the complete resulting Surface at every write boundary, including creation, tree patch,
  state patch, Template instantiation, Tree-proposal application, daemon-owned materialization, and
  replayed persistence. A failed validation commits no partial tree, state, presentation, Event, or
  realtime update.
- Preserve `UnknownAtom` as a visible last-resort renderer for version skew or corrupt client input.
  It is not a successful authoring path: the Gateway must reject a Surface it cannot guarantee the
  current catalog contract can render.
- Treat actionable controls as actionable by construction. An accepted Button or value-changing
  control has the action required by its semantic contract; display-only content uses the
  corresponding non-interactive Atom rather than an inert control.
- Give Input and Textarea submit-only semantics in v1. Their bindings supply committed initial
  values, edits live in a local draft owned by the nearest Form, and Form submission dispatches one
  complete field-value payload through its declared action. Typing does not patch Surface state or
  append an Event. Submission failure keeps the draft visible; a committed canonical update
  reconciles it.
- Keep the existing immediate change semantics for controls whose purpose is a single bounded
  selection, such as Checkbox, Select, RadioGroup, and DatePicker. Their strict contracts still
  require compatible bound state and an unambiguous declared action.
- Define Chart v1 as one series rendered as either `line` or `bar`, with explicit `xKey` and `yKey`
  over a bound array of records. Labels and numeric values must validate before persistence. Multiple
  series, inferred field names, and arbitrary chart options are not accepted in v1.
- Add `presentation: standard | full` to the Surface contract. Omission on creation defaults to
  `standard`; the Agent may select `full` when the initial content benefits from the complete row.
  Presentation belongs to the Surface host, not Box or another Atom, and no raw CSS, pixel width,
  percentage, or grid instruction crosses the protocol.
- Expose one typed Surface-presentation mutation through the focused and explicitly scoped global
  Agent tool registries. It changes only presentation, uses the ordinary validated Surface engine,
  records the owning Space Event, broadcasts the authoritative result, and cannot be inferred from
  arbitrary Atom props.
- Permit post-creation presentation changes only for an explicit current user request. State
  patches, Automations, proactive work, Template reuse, and ordinary recomposition preserve the
  existing presentation unless that request authorizes a change.
- Make successful authoring tool results carry the authoritative committed Surface outcome and
  versions needed for honest Agent reporting. A validation or persistence failure is a tool failure;
  the Agent may issue a corrected call, but final text may claim success only after a committed
  result or accurately report a Tree proposal.
- Keep natural-language interpretation in the Agent. The Gateway gains no Weight Tracker, gym,
  nutrition, presentation-keyword, or other domain-specific parser.
- Preserve Connection parity, provenance, live taint, Pin, Template, Tree proposal, Event log,
  ordering, and realtime-delivery rules. This work strengthens their common accepted input rather
  than creating a second Surface path.
- No legacy Surface migration is required because Veduta has no released installation. Development
  and acceptance testing use an isolated clean data root; existing local data remains untouched
  unless a later recoverable cleanup is explicitly needed.

## Testing Decisions

- The authoritative acceptance seam is the existing clean Local VPS full-stack browser journey with
  the real PWA, Gateway, Surface engine, catalog, persistence, WebSocket delivery, and deterministic
  Model connection. Tests assert visible and operable outcomes rather than implementation details.
- The browser regression sends the reported requests: it creates a three-day gym plan with visible
  plan content, records 74 kg into a visible Weight Tracker record and chart, edits a text field and
  proves no durable change before Form submission, and changes one Surface from `standard` to
  `full`. Each result is checked live and after reload; persistence-critical cases are also checked
  after Gateway restart and from a second authenticated browser context.
- The same journey makes a deterministic provider attempt semantically invalid authoring and proves
  that no partial UI or durable mutation appears and that the final chat response reports failure
  honestly.
- Add one exhaustive schema-to-catalog conformance suite. For every v1 Atom it parses representative
  accepted Surfaces, renders the observable content, exercises required interactions, and rejects
  unsupported props, actions, children, bindings, and bound value shapes. This is the structural
  complement to the browser journey, not a substitute for it.
- Exercise Surface creation, state mutation, recomposition, presentation mutation, Template reuse,
  Pin interception, persistence, Event emission, and realtime delivery through their public engine
  and Gateway contracts. Do not make SQLite row layout or renderer helper calls the acceptance
  authority.
- Retain the existing provider-parity fixtures and add the new schema and presentation capabilities
  to them so every primary Model connection receives and produces the same outcomes.
- Run a documented non-CI smoke with an authorized ChatGPT Model connection using the reported
  Italian requests and a presentation request. It must show the same visible outcomes without code
  or prompt changes specific to that provider.
- `pnpm check` and the relevant browser E2E job must pass from clean data before any implementation
  ticket is complete.

## Out of Scope

- Free-form generated HTML, JSX, arbitrary styling, raw CSS values, percentage widths, or user-
  defined layout primitives.
- Surface presentation values beyond `standard` and `full`, automatic responsive policy authored by
  the model, or a general placement language.
- Multi-series, pie, scatter, stacked, interactive, or inferred-schema charts.
- Per-keystroke durable text updates, collaborative text editing, autosave, or a general form
  validation language.
- Hardcoded Health, Weight Tracker, Meals, gym, nutrition, or other life-area components and
  natural-language parsers.
- A visual redesign of the catalog, new Atom types, or changes to the PWA's fixed application
  routes.
- Recovery or migration of existing development Surfaces. Verification starts from isolated clean
  data while preserving the current local root as a recoverable reference.

## Further Notes

- This parent generalizes gaps exposed after completed issues #42, #73, and #95. Those issues proved
  that the Agent can call Surface tools and should author useful visual answers; they did not prove
  that every protocol-accepted Atom behavior is implemented by the renderer.
- Issue #107 already owns initiating-tab reveal of a successfully created card. This specification
  requires the revealed card itself to be meaningful and operable and does not change that reveal
  behavior.
- The accepted domain terms are Surface authoring and Surface presentation. Presentation is
  independent of the Atom tree, typed state, Pin, and Gateway-owned Surface order.
