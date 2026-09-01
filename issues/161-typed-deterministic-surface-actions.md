# 161 — Make fast-path Surface Actions produce typed deterministic mutations

## Problem Statement

Veduta can accept an interactive Surface whose Form or Button promises an operation such as adding
or recording an item, while the declared fast-path Action can only replace one bound state value or
copy a Form's text fields into state. The action commits, freshness advances, and a `fast_path`
Event is appended, but the collection rendered by the Surface remains unchanged. The user therefore
receives durable evidence of success without the visible result the accepted Surface promised.

The current Action contract exposes `stateKey` for one assignment and the Form-specific
`stateKeys` branch for several assignments. The PWA, Store, Surface engine, retry queue, and
post-mutation observers each understand part of that distinction. None can express a generic
append, record update, record removal, or clear operation, and a multi-step result such as “append
the submitted record, update the current value, then clear the draft” has no single authoritative
representation.

Letting a client send arbitrary JSON Patch operations would make the client an author of durable
Surface state, expose internal paths, and weaken Veduta's validation and Event log authority.
Adding Groceries, Weight Tracker, or other life-area handlers would instead duplicate the same gap
vertically and violate the closed, compositional Surface model.

The missing contract also prevents a clean future A2UI projection. A2UI and AG-UI can carry user
actions and data-model updates, but they do not define Veduta's schema, persistence, conflict
policy, idempotency, Surface commit, or Space Event provenance. Veduta needs one canonical action
outcome before any shallow adapter can project it safely.

## Solution

Give every fast-path Surface Action a closed, validated, domain-neutral mutation plan. A plan is a
finite ordered batch composed from `set`, `append`, `update`, `remove`, and `clear`. It declares its
complete write set, typed invocation inputs, collection identity rules, value sources, and
deterministic missing-target policy as part of the persisted Surface. The client sends only the
Action identity, typed input values, and one stable intent identity; it never sends target paths or
Patch operations.

One authoritative daemon execution path resolves the exact persisted Action against the latest
canonical Surface, validates the invocation, reduces the mutation plan over a working copy, and
compiles the result into an ordered canonical state Patch. Veduta then validates the complete
resulting Surface and completes one recoverable Surface commit containing the entire batch and one
matching `fast_path` Event. Invalid input, stale Action identity, an impossible selector, or an
invalid resulting Surface commits nothing.

Publish one canonical fast-action outcome per invocation. A mutating outcome becomes `committed`
only after the Surface commit is delivered; a declared deterministic no-op produces no Surface
version, Event, or observer call; and an incomplete durable commit remains `recovery_pending`
rather than success. Outcomes carry the resolved Action identity, stable intent identity, canonical
Patch when committed, authoritative Surface/version information, commit identity when one exists,
and duplicate status. Realtime, diagnostic, and domain observers consume committed outcomes
without becoming persistence or validation authorities. The PWA live-state runtime owns pending
work, retry, replay, and HTTP/realtime reconciliation, while React owns only presentation and local
Form drafts.

Keep the outcome deliberately projectable toward A2UI: a future shallow adapter may translate an
A2UI user action into the same Veduta invocation and translate the committed canonical Patch into
A2UI data-model operations. The adapter cannot bypass the Gateway, submit arbitrary durable
patches, or become authoritative for Space identity, versions, validation, persistence, or the
Event log.

## User Stories

1. As a Veduta user, I want an accepted Add action to append the submitted item to the visible collection, so that the Surface does what its control promises.
2. As a Veduta user, I want an accepted record action to update one identified item, so that I can correct durable Surface state without invoking the Agent.
3. As a Veduta user, I want an accepted removal action to remove exactly the intended item, so that another item cannot be changed because its array position moved.
4. As a Veduta user, I want an accepted clear action to reset its declared value or collection, so that bindings remain valid and the Surface remains renderable.
5. As a Veduta user, I want one Form submission to append a record, update related visible values, and clear its draft atomically, so that I never see a partially applied result.
6. As a Veduta user, I want a failed multi-step action to preserve the complete previous Surface, so that I do not have to repair half of an operation.
7. As a Veduta user, I want the Event log to contain one meaningful outcome for one action, so that the Agent finds the interaction before reasoning about my Space.
8. As a Veduta user, I want a retry of an acknowledged action to return the same result without duplicating records or Events, so that transport uncertainty is harmless.
9. As a Veduta user, I want a stale queued action to fail visibly rather than execute a newly redefined Action with the same label, so that delayed intent is not reinterpreted.
10. As a Veduta user, I want a missing or already removed target to follow a declared predictable policy, so that repeated actions never have surprising effects.
11. As a Veduta user, I want two different actions submitted close together to be reduced against canonical state in a deterministic order, so that concurrent use does not lose an append or overwrite another result.
12. As a Veduta user on two devices, I want both clients to converge on the same committed collection and related values, so that one Space never has device-specific truth.
13. As a Veduta user, I want a committed action to remain correct after reload, reconnect, and Gateway restart, so that visible state is durable rather than optimistic decoration.
14. As a Veduta user, I want pending, failed, and committed actions to be distinguishable, so that fast-path latency never looks like false success.
15. As a Veduta user, I want a failed submission to retain my local Form draft, so that I can correct or retry it without retyping.
16. As a keyboard or assistive-technology user, I want the existing labelled controls and status feedback to remain operable, so that the deeper Action contract does not reduce accessibility.
17. As a Veduta user, I want a pinned Surface to accept valid state actions without silently changing its Atom tree, so that Pin keeps its existing meaning.
18. As a Veduta user, I want invalid input or an invalid resulting Surface to produce no state, Event, or realtime change, so that rejected work is truly atomic.
19. As a Veduta user, I want private submitted values to remain subject to the existing Event redaction rules, so that provenance does not become a secret leak.
20. As the Agent, I want to author the same typed mutation plan for unrelated life areas, so that I do not need Groceries or Weight Tracker tools and templates in the Gateway.
21. As the Agent, I want an authoritative committed outcome from an action, so that Chat can report what actually changed rather than infer success from intent.
22. As the Agent, I want failed and recovery-pending Surface commits to remain distinguishable from success, so that I never reason over an unsettled Space as if it were complete.
23. As a Template author, I want Action mutation plans to survive validation and Template reuse, so that reusable compositions keep their behavior without retaining personal state.
24. As a Surface author, I want an invalid target key, collection shape, identity rule, or value mapping rejected before persistence, so that accepted controls cannot be structurally inexpressible.
25. As a contributor, I want fast actions represented by one discriminated contract rather than scalar and Form branches, so that new controls reuse one execution path.
26. As a contributor, I want mutation values assembled only from declared inputs, validated literals, and Gateway-owned metadata, so that Actions remain deterministic and inspectable.
27. As a contributor, I want clients prevented from submitting JSON Pointers or arbitrary Patch operations, so that the Gateway remains the mutation authority.
28. As a contributor, I want collection update and removal to use stable record identity rather than array indexes, so that ordering changes cannot retarget intent.
29. As a contributor, I want duplicate record identities rejected as invalid Surface state, so that selection can never be ambiguous.
30. As a contributor, I want one post-commit outcome per action rather than one notice per changed key, so that batch semantics are not reconstructed by observers.
31. As a subsystem owner, I want preconditions that can reject an action evaluated before its Surface commit, so that post-commit observers never veto durable state after the fact.
32. As an operator, I want the action's commit identity, Event, Patch, and diagnostic trace correlated without storing the complete raw payload, so that failures are inspectable and privacy-bounded.
33. As an operator, I want observer failures isolated from delivered Surface commits, so that successful work is never reported as failed after becoming durable.
34. As a future A2UI adapter author, I want one canonical invocation and committed Patch outcome, so that interoperability is a shallow translation rather than a second state engine.
35. As a future A2UI client user, I want the same Veduta validation, persistence, idempotency, and Event provenance as the PWA, so that transport choice cannot change product truth.
36. As a maintainer, I want the fast path to retain its existing latency target, so that a deeper contract does not turn deterministic interaction into Agent-like waiting.

## Implementation Decisions

- Replace the scalar `stateKey` and Form-specific `stateKeys` execution branches with one closed
  fast-action mutation-plan contract. Agent-path Actions retain their existing path and do not gain
  durable state mutation authority through this plan.
- A fast Action declares a non-empty ordered batch and its complete write set in the validated
  Surface. Every target is an existing top-level Surface state key. Invocation payloads cannot add
  target keys, widen the write set, or choose an operation variant.
- Keep five v1 mutation variants:
  - `set` replaces the declared state value with a value assembled from allowed sources.
  - `append` adds one typed scalar or record to the end of a declared array.
  - `update` changes only declared fields on exactly one record selected by stable identity.
  - `remove` removes exactly one record selected by stable identity.
  - `clear` replaces the target with its exact schema-approved empty value; it never deletes a
    state key that a binding or Action references.
- Apply batch steps in their declared order to one in-memory working Surface. Later steps observe
  the preceding steps' result. The plan has no loops, branches, callbacks, generated code, or
  runtime expressions.
- Limit value sources to fields declared by the owning Atom interaction, literals already validated
  in the persisted Action, and explicit Gateway-owned metadata such as a stable record identity or
  injected clock value. Object assembly and field mapping are allowed; arithmetic, aggregation,
  filtering, string evaluation, and a general formula or query language are not.
- An append to an object collection declares its stable identity field. Gateway-generated identity
  and time values are created once per stable intent and reused by idempotent replay. Mutable
  collection records must have unique identities; duplicate or missing identities invalidate the
  Surface before interaction. Arrays of primitives may be appended or cleared but are not eligible
  for identity-based update or remove.
- Update and remove never accept array indexes or JSON Pointers from a client. A missing target uses
  the Action's persisted `reject` or `noop` policy. Multiple matches are always invalid rather than
  resolved by order.
- Bind each invocation to the exact persisted node, Action, and Action-contract revision that the
  user saw. A queued invocation whose declaration changed is rejected as stale unless its stable
  intent already has a committed outcome; it is never evaluated under a replacement plan.
- Validate invocation inputs against the owning Atom's strict interaction contract before reducing
  the plan. Merge neither undeclared payload fields nor client-supplied targets into the persisted
  declaration.
- Resolve and reduce against the latest canonical Surface under the Surface engine's write
  serialization. Distinct concurrent intent identities execute in canonical order; the same intent
  identity returns the original outcome.
- Compile the reduced batch into the existing ordered state Patch representation inside the
  daemon. JSON Pointer paths remain an internal Patch detail and never cross the invocation seam as
  client authority.
- Validate the complete resulting Surface, including Atom semantics, bindings, collection identity,
  relative-time restrictions, and presentation, before persistence. Any invalid intermediate or
  final outcome aborts the complete batch.
- Preserve the relative-time contract from issue #134. Generic fast Actions do not bypass its
  prohibition on independently mutating source or projection keys; coherent temporal authoring
  remains under that dedicated contract.
- Complete the batch through the recoverable Surface-commit protocol from ADR-0030 and issue #156.
  One invocation produces one Surface mutation, one prepared redacted `fast_path` Event, and one
  stable commit identity regardless of the number of mutation steps.
- Return success only after the Surface commit is delivered. A failure before the durable SQLite
  portion leaves no mutation or Event; a failure after it but before Event delivery returns the
  identifiable recovery-pending outcome defined by ADR-0030 rather than inviting resubmission.
- Replace per-state-key fast mutation notices with one discriminated fast-action outcome.
  `committed` includes Surface, node, Action and intent identities, ordered canonical Patch,
  authoritative Surface and tree versions or equivalent revision data, Surface commit identity,
  Event cursor, and duplicate status. `noop` carries the resolved identities and reason but no
  invented Patch, version, Event, or commit. `recovery_pending` carries the stable commit identity
  needed for reconciliation and is not success.
- Run realtime, Trace, notification, and other observers only after commit delivery. Observer
  failure is diagnostic and cannot roll back, reject, or change the action response. Consumers may
  inspect the ordered Patch or resulting Surface without reconstructing a batch from multiple
  callbacks.
- Move any existing consumer precondition capable of rejecting an action into the authoritative
  execution path before the Surface commit, or keep that behavior on its existing typed domain
  path. Post-commit consumers may project a delivered outcome but cannot become a second validator.
- Integrate invocation lifecycle into the PWA live-state runtime from issue #155. The runtime owns
  stable intent identity, pending state, persisted retry entries, reconnect replay, HTTP/realtime
  races, canonical snapshot replacement, and outcome deduplication. React retains local Form drafts
  and renders runtime status.
- Persist the complete typed invocation and Action-contract revision for retry. A retry reuses the
  same intent identity. A stale or removed Action produces a visible terminal rejection and is not
  silently rewritten or retried as a new intent.
- Do not implement the general mutation reducer in the PWA. The runtime may retain reversible
  speculation for the existing single-key `set` case when it can reconcile unambiguously; batches,
  append, update, remove, and clear remain pending until the canonical committed outcome arrives.
  Confirmed cached state remains the offline read authority.
- Keep the daemon-to-PWA protocol typed and provider-neutral. Both HTTP results and realtime frames
  carry enough outcome identity and revision information for the runtime to converge regardless of
  arrival order without applying the same Patch twice.
- Preserve the strict Form draft behavior from completed issue #142. A direct-edit Form can still
  set its fields atomically; a command-like Form uses the same mutation-plan contract to change the
  collection and any related visible state in one batch.
- Update Templates, seed Surfaces, daemon-owned Surfaces, and fixtures to preserve and validate the
  new Action declaration. Template extraction records state-key dependencies and mutation shape,
  never literal personal state or Gateway-generated identities.
- Retire the legacy scalar/Form Action bifurcation after all repository-owned declarations use the
  unified plan. Veduta has no released installation, so acceptance uses an isolated clean data root
  and does not heuristically reinterpret arbitrary development Surfaces with legacy Action shapes.
- Keep A2UI compatibility asymmetric and projection-only. A future adapter may map an A2UI user
  action to the same typed invocation and map the committed canonical state Patch to A2UI
  data-model operations. It cannot supply a mutation plan, authorize a write, persist state, assign
  canonical versions, or append Events.
- Do not add an AG-UI transport or A2UI adapter until a concrete second consumer exists. The stable
  seam produced now is the committed Veduta outcome, not a speculative interoperability module.
- Update ADR-0003 and `ARCHITECTURE.md` in the implementation that lands this contract. Record the
  final mutation variants, the Gateway/client authority split, the Surface-commit and outcome
  lifecycle, and the projection-only A2UI rule; cite this durable issue specification rather than
  the temporary architecture-review report.

## Testing Decisions

- Use the existing running PWA-to-Gateway Surface action journey as the highest acceptance seam.
  Tests exercise a real rendered control, authenticated invocation, authoritative daemon reduction,
  Surface commit, Event delivery, realtime convergence, reload, and visible canonical result. They
  assert user-observable behavior rather than reducer helpers or SQLite row layout.
- Use two unrelated declarative test Surfaces as tracer fixtures: one appends and manages items in a
  simple collection; the other appends a measurement, updates its current displayed value, and
  clears its draft in one batch. Their production path shares every module and contains no fixture,
  Groceries, Health, or Weight Tracker branch.
- Through the public Surface action execution seam, cover `set`, `append`, `update`, `remove`, and
  `clear`, plus one ordered multi-operation Form batch. Verify canonical state, full Surface
  validation, one Event, one committed outcome, and one realtime delivery per invocation.
- Cover invalid Surface declarations before persistence: absent target keys, wrong target types,
  undeclared inputs, duplicate or missing record identities, unsupported update fields, client
  pointers, ambiguous selectors, invalid clear values, and plans that violate relative-time state
  restrictions.
- Cover invalid invocations without partial effects: malformed typed input, extra fields, missing
  selector, stale Action revision, missing target under `reject`, and a reduced Surface that fails
  semantic validation. Assert the prior Surface, Event log, observers, and connected clients remain
  unchanged.
- Cover deterministic no-op behavior separately. A declared `noop` for an absent record returns a
  canonical non-mutating outcome without fabricating a Surface version, Event, or observer call;
  replay returns the same classification.
- Cover idempotency at the public execution seam and after restart. The same intent identity returns
  the original generated record identity, clock values, commit identity, Patch, and Event cursor;
  it never appends a second record or Event.
- Cover concurrency with two authenticated clients. Distinct appends both survive in canonical
  order, update/remove use stable identity despite intervening order changes, and HTTP/realtime
  arrival in either order converges to the same snapshot.
- Reuse the PWA runtime seam established by issue #155 to test pending state, retained Form draft,
  persisted retry, reconnect, duplicate response/live delivery, stale queued rejection, and
  canonical rollback of any permitted single-key speculation without rendering React.
- Add app-level tests proving React dispatches typed commands and renders pending, committed, stale,
  recovery-pending, and failed outcomes while keeping local drafts; React tests do not reimplement
  transport, queue, or reduction algorithms.
- Reuse ADR-0030 fault-injection coverage to prove no committed outcome or observer runs before
  durable Event delivery, recovery emits the outcome once, and a post-commit observer exception
  cannot turn delivered success into an action failure.
- Migrate existing fast-action consumers through contract tests that receive one batch outcome.
  Prove that consumers inspect declared effects or canonical state once and never rely on callback
  count or per-key ordering.
- Add protocol round-trip tests proving the mutation plan and committed outcome are closed,
  serializable, reject additive unknown fields where authority matters, and retain the conceptual
  mapping required by ADR-0003. A2UI libraries or network transport are not test dependencies.
- Review ADR-0003 and `ARCHITECTURE.md` against the implemented schemas and public outcomes. The
  documentation must no longer describe `stateKey` or `stateKeys` as the complete fast-action
  contract after those branches are retired.
- Use existing Form action, Surface engine, Gateway fan-out, consecutive one-shot action, PWA queue,
  and Surface commit suites as prior art. Extend their public behavior coverage instead of creating
  a parallel test harness.
- Run the clean-data browser journey live and after reload, reconnect, and Gateway restart. A second
  authenticated session must converge, and Chat or visible status must never report a collection
  change until the canonical collection changed.
- Keep the isolated fast-path p95 within the existing 100 ms product target and run `pnpm check`
  plus the relevant browser E2E job before completion.

## Out of Scope

- Groceries, Weight Tracker, Health, nutrition, finance, or other life-area components, parsers,
  state-key conventions, or production templates. Domain examples are acceptance fixtures only.
- Client-authored JSON Patch, JSON Pointers in invocation payloads, arbitrary state-key selection,
  generated code, callbacks, a formula language, a query language, filtering, aggregation, or
  conditional mutation scripts.
- Bulk update or removal by predicate, insertion at arbitrary collection positions, collection
  sorting or reordering, cross-Surface transactions, and fast-path Atom-tree mutation.
- Free-form HTML or JSX, new domain Atoms, a visual redesign, or changes to the closed catalog
  principle.
- Changes to Agent-path Action execution, Model connection routing, trust levels, Approval cards,
  or external side-effect authorization.
- Replacing Veduta's Gateway with AG-UI, replacing the Surface protocol with direct A2UI adoption,
  migrating to Hermes, or shipping an AG-UI/A2UI adapter without a concrete consumer.
- Relaxing issue #134's occurrence-time and relative-projection rules or introducing a generic
  fast-path calculation engine for temporal projections.
- Heuristic migration of arbitrary development Surfaces using legacy `stateKey` or `stateKeys`
  declarations. Verification uses isolated clean data and leaves the current developer data root
  untouched.

## Further Notes

- This is a child of [#140](https://github.com/Ic3b3rg/veduta/issues/140), whose canonical
  specification is
  [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md).
  It resolves the verified post-[#142](https://github.com/Ic3b3rg/veduta/issues/142) gap where
  accepted command-like Forms durably changed only their draft fields while rendered collections
  remained empty.
- The design is grounded in
  [ADR-0003](https://github.com/Ic3b3rg/veduta/blob/main/docs/adr/0003-declarative-atoms.md),
  [research 17](https://github.com/Ic3b3rg/veduta/blob/main/docs/references/17-ag-ui-hermes-veduta.md),
  and [research 18](https://github.com/Ic3b3rg/veduta/blob/main/docs/references/18-ag-ui-a2ui-subscriptions.md).
  Those sources make Veduta's validated Surface, fast path, persistence, and Event log authoritative;
  AG-UI/A2UI are possible transport and projection layers, not a replacement domain store.
- The recoverable commit semantics come from
  [ADR-0030](https://github.com/Ic3b3rg/veduta/blob/main/docs/adr/0030-recoverable-surface-commits.md)
  and [#156](https://github.com/Ic3b3rg/veduta/issues/156). Client lifecycle and reconciliation
  reuse [#155](https://github.com/Ic3b3rg/veduta/issues/155).
- Blocked by #155 and #156. Once complete, this contract unblocks #146; #150 consumes the resulting
  end-to-end behavior through its clean-root parent acceptance suite.
- The four architecture-review opportunities are intentionally one end-to-end slice here: the
  Action declaration, authoritative daemon reducer, committed outcome seam, and PWA runtime
  integration have value only when they agree on one invocation and one canonical result.
