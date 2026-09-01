# 150 — Close generic Atom acceptance and prove honest Surface authoring

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Close the temporary generic Atom acceptance seam and make semantic operability a system invariant. Every recognized Atom type must enter through its strict contract, every complete Surface mutation path must validate the same tree before persistence, and a failed subtree must reject the whole proposed mutation. Tool results and Chat confirmations must be derived from the canonical accepted Surface, never from model intent alone.

Prove the contract with the four reported regressions together: editable Form text, a complete three-day gym plan, a visible 74 kg Weight Tracker update, and an explicit `full` Surface presentation change. This is the expand-and-contract ticket that makes those fixes systemic rather than template-specific.

## Acceptance criteria

- [ ] The shared Atom tree is a closed discriminated union of the contracted catalog; known Atom types no longer pass through a generic props or children schema.
- [ ] A maintained conformance matrix maps every accepted Atom to its validator, renderer, interaction semantics when applicable, accessibility behavior, and test coverage.
- [ ] Surface creation, replacement, patching, template materialization, proposal acceptance, Gateway-owned writes, and replay validate the same complete semantic tree before persistence.
- [ ] Any invalid subtree rejects the complete proposed write atomically, preserves the prior canonical Surface, and returns a precise machine-readable error.
- [ ] Protocol version skew still renders a genuinely unknown Atom visibly through `UnknownAtom`; it does not reopen generic acceptance for known types.
- [ ] Agent tools report success only from the canonical persisted result, and Chat cannot claim content, data, interactions, or presentation that the Surface does not contain.
- [ ] One clean-root end-to-end suite proves Form editing and submit, the complete three-day gym plan, the 74 kg Weight Tracker update, and explicit `full` presentation live and after reload.
- [ ] The regression suite fails if any scenario produces an empty card, inert accepted control, stale visualization, ignored presentation, or false Chat success.
- [ ] Mock-provider and real-provider paths share the same tools and validation boundary; provider-specific prompt behavior is not required for correctness.
- [ ] Manual real-ChatGPT smoke instructions cover the four scenarios without requiring destructive reset or legacy-data migration.
- [ ] Tests run from a clean isolated data root and remove their persistent artifacts.
- [ ] Relevant browser E2E passes and `pnpm check` passes.

## Blocked by

- #143
- #145
- #146
- #147
- #148
