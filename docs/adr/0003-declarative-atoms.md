# Surfaces = a tree of declarative Atoms from a closed catalog, never free-form HTML

A Surface is a declarative tree of **Atoms** from a closed catalog, bound to **typed state** via bindings. Veduta owns the canonical protocol, persistence, validation, and execution; A2UI supplies conceptual inspiration. The Agent instantiates and patches, it does not generate markup. Every Atom action declares its path: **fast path** (deterministic mutation + matching Event, zero LLM) or **agent path**.

Rationale: (1) persistent Surfaces must be updatable via diffs — free-form HTML cannot be patched reliably; (2) a closed catalog provides visual consistency; (3) structured UI protocols inform the design without owning local execution. Good compositions become saved and reused **Templates** (consistency across regenerations).

Status: accepted

## Issue 002 protocol mapping

For v1 we use an A2UI-inspired mapping rather than direct adoption of OpenClaw-style Canvas markup (`a2ui-component`, `a2ui-action`, declarative HTML). Direct adoption would reintroduce generated markup into the persistent Home, conflicting with the closed Atom catalog and typed state contract.

Mapping:

- A2UI component → `AtomNode` (`type`, JSON `props`, `children`)
- A2UI action concept → Veduta `Action` (`name`, `path: "fast" | "agent"`); fast Actions carry a closed typed plan, while Agent Actions retain their declared JSON payload
- Component state → `Surface.state`, addressed by Atom `binding`
- Incremental updates → `Patch` operations scoped to `state` or `tree`

The compatibility target is conceptual: agents can produce structured UI actions and components, while Veduta keeps persistence, validation, and rendering under the local protocol.

## Unified fast Action execution (issue #161)

Every fast Action declares one plan with typed owning inputs, exact existing top-level state
targets, and an ordered batch of `set`, `append`, `update`, `remove`, or `clear` steps. Values
come from typed interaction inputs, literal JSON, flat record mappings, or the Gateway's `recordId`
and `now` metadata. Object collections declare unique nonempty string or number identities;
updates and removals select that identity and explicitly reject or no-op when it is missing.
There are no client-selected targets, array indexes, predicates, nested paths, formulas, or scripts.

The Gateway seals an opaque UUID revision for the persisted Action declaration and its owning
input semantics. Unchanged semantics retain it; changed plans, controls, or Form fields receive a
new revision. Author-supplied revisions grant no authority. A strict invocation carries only the
node, Action name, revision, stable UUID intent identity, and typed inputs. A new stale intent is
rejected. An already recorded intent returns its original result even after the declaration changes.

The engine reduces the latest canonical state under its existing write serialization. It validates
every intermediate complete Surface before any durable write and runs read-only domain preconditions
before commit. One changed batch persists its Surface, Patch, intent outcome, and recoverable Space
Event intent in one SQLite transaction. Event delivery completes before success or projections.
The Event identifies the Action and its target names without copying submitted values. See
[ADR-0030](0030-recoverable-surface-commits.md) for reconciliation.

The shared outcome is `committed`, `noop`, or `recovery_pending`. A committed outcome includes the
original canonical Surface, Patch, versions, Surface commit identity, and Event/Surface cursors.
The Event cursor is the matching `SurfacePatchEvent.cursor`; the Space Event shares its commit
identity. HTTP uses 200 for committed/no-op results and 202 for pending delivery. Replay returns
the original outcome with `duplicate: true`. A no-op creates no Patch, Surface version, commit,
or Space Event. The same committed metadata accompanies the realtime Patch as `actionOutcome`.

Post-delivery consumers receive one committed batch. Actual domain projections retain named
receipts, replaying only delivered outcomes still awaiting that consumer. A successful asynchronous
projection records its receipt after completion. Exceptions remain diagnostics and never reverse
the original success. Domain decision authorities keep their existing exactly-once gates. State
projections inspect current canonical state so an older receipt cannot restore an older choice.

Input and Textarea keystrokes remain local drafts. An owning Form submits its complete typed
input set; it may append a record, update another bound value, and clear draft sources in one plan.
An Input may declare `valueType: 'number'`; the owning control converts a finite submitted text
value to a number while its canonical draft binding stays a string. Button inputs are empty;
fixed values belong in the declared plan.

Templates retain portable plans and all target dependencies, with schema-appropriate empty defaults.
Gateway revisions and generated record identities stay outside the Template. Literal instance
record selectors or personal append/set data make extraction/import fail visibly instead of
inventing a neutral identity. Imported Agent Actions remain stripped. This pre-1.0 boundary requires
clean data roots: legacy scalar `stateKey` and Form `stateKeys` declarations are rejected, not
heuristically rewritten.

Any future A2UI or AG-UI adapter is a projection of canonical Veduta state and outcomes. It cannot
introduce a second reducer, state authority, domain executor, or LLM route for deterministic local
interactions. The layer distinction is documented in [research 17](../references/17-ag-ui-hermes-veduta.md)
and [research 18](../references/18-ag-ui-a2ui-subscriptions.md).

## Issue 029 progressive composition

Progressive composition is a usage pattern inside the existing Surface contract, not a second
streaming format. The Agent creates the complete layout with typed `Pending` leaf Atoms, then
replaces each leaf with a separate versioned tree patch as content becomes ready. A replacement
preserves the Atom id so the catalog applies entrance motion only to that region.

The daemon owns the start of each Pending window. On creation, or when a patch inserts a Pending
subtree, it stamps `props.startedAt` with its own clock; a supplied value is overwritten. The
catalog computes the remaining time from that persisted timestamp and `timeoutMs`, so reloads and
remounts cannot restart an ordinary composition window. An unstamped or malformed Pending Atom is
shown immediately as a visible unavailable state. `startedAt` remains optional in the input schema
so Agent tool calls can omit server-owned metadata before the daemon validates and persists the
canonical tree.

Tree patches still replace and validate the complete Surface value. The catalog therefore
memoizes unchanged Atom subtrees by their rendered inputs (tree data, bound state, theme, relevant
motion update, and action dispatch). This preserves correctness for interactive or state-bound
regions while preventing already-filled siblings from rendering again during later fills. A stable
dispatch proxy forwards interactions to the latest host callback, so an unchanged interactive
region does not need to render merely because its host closure changed.

The rejected alternative remains a node-stream parser: it would duplicate validation and trust
boundaries without improving the user-visible result. A mount-relative timer was also rejected
because remounting could keep a skeleton alive indefinitely.

## Issue 134 relative calendar views

A Surface whose visible state means “today”, “this week”, or “this month” declares that meaning in
an optional, generic `validity` descriptor. The descriptor identifies a durable source array, the
source record's effective-occurrence field (default `occurredAt`), the projected state keys, and a
calendar window. The Gateway supplies the global user timezone and absolute `startsAt`/`expiresAt`
bounds; models never author those authoritative values. Event log time remains the time Veduta
recorded the mutation, while `occurredAt` is when the real-world fact happened.

Source records and visible projections stay separate. A write that touches the source or any
projection must update every declared projection in the same validated patch, so the view cannot
claim a fresh window with stale dependent fields. Older records remain in the source array. Legacy
records without an occurrence time also remain durable, but readers exclude them from the relative
projection and expose a caveat instead of guessing a date.

Validity is persisted and carried by replayable Surface patch events. Focused readers compute its
status against the injected clock, while the PWA schedules the next start/expiry boundary locally;
therefore a cached view visibly expires even if no Gateway event arrives. A subsequent coherent
state patch refreshes the bounds from the same global timezone. Pin continues to lock only the Atom
tree, so state and validity can advance together.

Data version 2 adds the persisted validity column and reconciles earlier persisted seed Surfaces
through the same validated state-patch and Event paths. The reconciliation is driven only by the
frozen version-2 contract and Surface identity: when the source is absent and the old state has
exactly one array projection, its object records become undated source records and every current
projection resets to the version-2 defaults. Source-present or otherwise ambiguous legacy shapes are
refused rather than risking data loss or classifying them by a title or field-name guess.

Rejected alternatives were title/field-name heuristics, a Surface query language, domain-specific
meal logic in the protocol or catalog, storing only the current projection, and generating fake
domain events or Heartbeats at midnight. Each would either hide semantics, lose history, duplicate a
query engine, or make correctness depend on unrelated background activity.

## Semantic Atom acceptance and Surface presentation (issue #140)

Protocol-valid now means visibly renderable and, for interactive Atoms, operable. Every catalog
Atom has one type-specific contract for props, children, bindings, bound value shapes, and actions;
the Gateway rejects unsupported semantics before persistence instead of relying on the catalog to
ignore fields it does not understand. The visible `UnknownAtom` fallback remains protection against
client-version skew or corrupt input, not a successful authoring path. Every complete result is
revalidated after creation, state mutation, recomposition, Template reuse, or Tree-proposal
application, and the Agent may report success only from the authoritative committed outcome.

Input and Textarea use a local draft owned by their nearest Form and dispatch the complete draft
only on submit; keystrokes are not durable mutations. Chart v1 is one explicitly keyed series in
`line` or `bar` form. A Surface also owns `presentation: standard | full`, separate from its Atom
tree, typed state, Pin, and canonical order. The Agent chooses presentation at creation and may
change it later only for an explicit current user request; models never author CSS, percentages, or
grid instructions.

## Selection and action controls (issue #146)

Button, Checkbox, Select, RadioGroup, and DatePicker have strict props and are leaves: even an
empty `children` array is rejected. Each requires a visible nonempty `label`, permits an optional
boolean `disabled`, and declares exactly one Action. Their owning interaction contracts are:

| Atom       | Additional props                                                                  | Canonical bound value                                                          | Action inputs                                           |
| ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Button     | Optional `variant`: `default`, `secondary`, or `ghost`                            | No binding                                                                     | Empty inputs; the declared Action supplies fixed values |
| Checkbox   | None                                                                              | Boolean                                                                        | Fast `toggle` with `{ value: boolean }`                 |
| Select     | Nonempty `options` of strict `{ label, value }` objects with unique string values | An offered option value                                                        | Fast `change` with `{ value: string }`                  |
| RadioGroup | The same option contract as Select                                                | An offered option value                                                        | Fast `change` with `{ value: string }`                  |
| DatePicker | Optional `allowEmpty`                                                             | A real calendar date in `YYYY-MM-DD` format; `''` only with `allowEmpty: true` | Fast `change` with `{ value: string }`                  |

Selection input enums exactly match the offered values. The last plan step targeting a selection
control's own binding must set it from `input.value`; other batch targets remain available.
Complete Surface validation checks current bound values and every statically known literal or
`clear` assignment in a fast plan, including intermediate writes. Gateway record identities and
timestamps cannot supply calendar-only dates. Dynamic inputs still undergo the existing invocation
and intermediate Surface validation before persistence. This preserves the ordered batch contract
of issue #161 instead of admitting a plan that can only fail during execution.

A Button may retain its declared Agent Action. A supplied Agent payload must exactly match the
declared payload, and a disabled Button is rejected before enqueue or Event creation. Fast Button
inputs remain empty; fixed payload values belong in the persisted plan.

Agent Actions now execute through the same serialized Space session, AgentRunner, ModelRouter,
and gated tools as Chat. The durable request retains its captured Surface, Atom, payload, and
content origin; captured content remains data and cannot grant tool or presentation authority.
The matching `agent_path` Event must be delivered before execution. Its turn identity and optional
client retry key correlate the request with its durable outcome. The HTTP and realtime status
projection exposes only `queued`, `running`, `completed`, or `failed`, never private snapshots.

The PWA supplies one persisted UUID per unsettled Agent interaction. Identical retries return the
original turn, including after its declaration changes or the Gateway restarts; conflicting use
of that identity is rejected. A queue acknowledgment is not completion. Controls retain visible
waiting or failure feedback until the exact terminal outcome is received, and a completed outcome
can be acknowledged only after the PWA's canonical Surface cursor reaches its completion cursor.
Model text cannot turn a rejected write into successful control feedback. New gestures after a
terminal outcome receive new identities.

On restart, queued requests enter the existing loop once. An interrupted running request is
reported as failed and is never automatically executed again: effects may already have occurred.
Historical requests without execution tracking are also visibly failed instead of replayed or
assigned an invented trusted origin. Surface writes still use their existing recoverable commit
and Event paths; Agent status changes do not fabricate another Surface mutation.

The catalog uses labelled native controls and the RadioGroup keyboard interaction. Displayed values
come from canonical state. An outstanding invocation disables its control, exposes `aria-busy` and
a visible status, and a failure exposes an associated accessible alert while permitting retry.
Matching late canonical confirmations clear local pending or error feedback, including for an
unbound Button. The existing PWA runtime owns intent identity, retry, queueing, and reconciliation;
the catalog does not add a reducer or transport controller.
The runtime also projects pending, queued, or failed Agent status per control. A navigation remount
or reload therefore restores an honest wait or recoverable error while the original invocation
awaits confirmation. These statuses and completion receipts never become persisted Surface state.

Required selection and date controls need explicit valid initial state when a Template's neutral
default cannot satisfy their contract. Template reuse does not choose the first option or today's
date. An explicitly optional DatePicker may use the empty default. Stripping an imported Agent
Action cannot make an inert Button acceptable.

Conformance evidence is maintained at public boundaries:

- [Protocol declarations, canonical values, and plan validation](../../packages/protocol/src/control-atoms.test.ts)
- [Catalog interaction and accessible feedback](../../packages/catalog/src/control-contracts.test.tsx)
- [Gateway persistence, invocation, Event, and Chat acceptance](../../packages/daemon/src/control-actions-acceptance.test.ts)
- [Actual SurfaceCard and runtime late Button recovery](../../packages/pwa/src/surface-control-recovery.test.tsx)
- [Agent SurfaceCard completion, late recovery, remount, and reload](../../packages/pwa/src/surface-agent-control-recovery.test.tsx)
- [Authenticated two-session pointer and keyboard journey, retry, reload, and reconnect](../../packages/e2e/tests/controls.spec.ts)
- [Agent execution, concurrent retry, atomic failure, and restart through the Gateway](../../packages/daemon/src/agent-action-acceptance.test.ts)
- [Authenticated Agent execution, rejected writes, retry, reload, and Gateway restart](../../packages/e2e/tests/agent-actions.spec.ts)

## Read compatibility for Atom version skew (issue #148)

Authoring and persistence keep the closed canonical Atom catalog. Client reads have an explicit
`RenderableAtomNode` / `RenderableSurface` projection, used consistently by HTTP responses,
Gateway frames, confirmed cache, and patch replay. A known type must satisfy its current catalog
contract. A genuinely unknown name may retain JSON metadata and valid known descendants so
`UnknownAtom` can show its original type and identity. Future metadata is never an executable
local action or binding declaration.

Known validation uses a separate tree value in which unknown nodes serve only as inert containers;
the rendered and cached tree retains the original unknown nodes. This preserves Form ancestor
context and known descendant state validation without admitting unknown types to the authoring
schema. Both read and canonical patches use the same application algorithm and validate the complete
result with their own schema. A renderable read value remains invalid for canonical persistence or
Template import until the local catalog implements that Atom.

## Considered Options

- Free-form generated HTML/JSX in a sandbox: rejected for v1 — not diffable, inconsistent, hallucination-prone. It returns post-v1 only as a sandboxed escape hatch for the long tail.
- Hardcoded domain components (meal-card, weight tracker): rejected — they betray GenUI genericity; domains emerge from composition, not from code.
