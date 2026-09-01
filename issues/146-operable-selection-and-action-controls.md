# 146 — Make every selection and action control operable

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Make every accepted selection and action control operable through one strict semantic contract. Cover `Button`, `Checkbox`, `Select`, `RadioGroup`, and `DatePicker`: each control must expose a validated value or action, dispatch through the existing fast path, append the required Space Event for mutations, and reconcile with canonical Surface state.

The implementation must be generic across Surfaces. A control whose binding or action cannot be executed must be rejected before persistence rather than rendered as a convincing but inert affordance.

## Acceptance criteria

- [ ] `Button`, `Checkbox`, `Select`, `RadioGroup`, and `DatePicker` each have strict type-specific schemas for props, children, values, bindings, actions, and payloads.
- [ ] Every accepted control is operable by keyboard, pointer, and assistive technology with visible labels, focus, disabled, and error states.
- [ ] Selection controls render their canonical value and dispatch a typed next value that satisfies their schema.
- [ ] Buttons dispatch only their declared typed action and cannot submit an unrelated or incomplete payload.
- [ ] Each successful durable mutation appends exactly one discoverable Space Event and reconciles every connected client with canonical state.
- [ ] Retries are idempotent and do not duplicate mutations or Space Events.
- [ ] Action failure is visible, leaves the control in a recoverable state, and never produces a false success claim in Chat.
- [ ] Missing options, invalid dates or values, duplicate option identities, and unresolved actions fail before Surface persistence.
- [ ] No Surface type, life area, or domain-specific command parser is required to make the controls work.
- [ ] Protocol, catalog, and Gateway tests cover valid interactions, invalid contracts, accessibility state, failure, retry, and reconciliation.
- [ ] A browser test exercises each control family through the running PWA and proves persistence after reload.
- [ ] `pnpm check` passes.

## Blocked by

- #142
- #161
