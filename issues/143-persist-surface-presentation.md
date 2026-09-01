# 143 — Persist explicit standard/full Surface presentation

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Make Surface presentation an explicit persisted contract with the values `standard` and `full`. A Surface defaults to `standard`, may be created as `full` when the content calls for it, and changes presentation later only after an explicit user request. The Agent must use a typed operation rather than smuggling layout through Atom props or generated styling.

The change must flow through the Gateway, Space Event log, subscriptions, and PWA so every connected client converges. Presentation is independent of Pin state and ordering.

## Acceptance criteria

- [ ] The shared Surface contract validates one explicit presentation value: `standard` or `full`.
- [ ] New Surfaces default deterministically to `standard` when no presentation is requested.
- [ ] Surface creation may select `full` from content needs, without accepting raw CSS, arbitrary dimensions, or generated HTML.
- [ ] Changing an existing Surface presentation requires an explicit user request and a typed focused-Space or global Agent operation.
- [ ] A presentation change is persisted atomically, appends to the correct Space Event log, and is idempotent under retry.
- [ ] The PWA renders `standard` and `full` distinctly without changing Pin state, order, or Surface content.
- [ ] Reload, Gateway restart, and a second connected client all preserve and converge on the canonical presentation.
- [ ] Invalid presentation values fail before persistence and are reported honestly to Chat.
- [ ] Protocol, Gateway, and PWA tests cover creation, explicit change, invalid input, retry, reload, restart, and multi-client convergence.
- [ ] A browser test proves an explicit Chat request changes a Surface to `full` and that the result survives reload.
- [ ] `pnpm check` passes.

## Blocked by

- #139
