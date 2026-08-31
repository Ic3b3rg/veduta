# 142 — Make Form text edits submit atomically

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Deliver the first end-to-end semantic Atom slice through `Form`, `Input`, and `Textarea`. Text edits stay as local draft state owned by the nearest `Form`; only an explicit submit produces one typed payload and one durable mutation. The same contract must be validated before persistence and rendering, so accepted controls are usable and invalid controls fail closed instead of appearing inert.

This ticket establishes the reusable semantic seam needed by the remaining Atom families. It must not introduce Surface-specific parsers or persist every keystroke.

## Acceptance criteria

- [ ] `Form`, `Input`, and `Textarea` have strict, type-specific schemas for props, children, binding, actions, current value, and submitted payload.
- [ ] An accepted text control is editable with keyboard, pointer, and assistive technology, with a visible label and focus state.
- [ ] Typing changes only the nearest `Form` draft and does not dispatch an action, append a Space Event, or mutate durable Surface state.
- [ ] Submitting dispatches exactly one typed action containing the complete current Form payload, including multiple text controls when present.
- [ ] A successful submit reconciles the draft with canonical Surface state and survives reload.
- [ ] A failed submit leaves the draft available, communicates the failure, and permits an explicit retry without duplicating a successful mutation.
- [ ] Invalid or incomplete Form semantics are rejected before persistence; no accepted control can render as an inert text field.
- [ ] Existing non-Form Surface controls keep their current behavior while this tracer slice lands.
- [ ] Catalog and protocol tests cover valid, invalid, editing, submit, failure, and reconciliation behavior.
- [ ] A browser test proves editing and submitting a text field through the running PWA.
- [ ] `pnpm check` passes.

## Blocked by

None (can start immediately).
