# 148 — Contract layout, media, motion, and fallback Atoms

## Parent

#140 — [Make every accepted Surface visibly operable](https://github.com/Ic3b3rg/veduta/issues/140)

Canonical specification: [issues/140-operable-surface-authoring.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/140-operable-surface-authoring.md)

## What to build

Close the semantic contract for the remaining layout, media, motion, loading, and compatibility Atoms. Known Atoms such as `Box`, `Row`, `Col`, `Spacer`, `Divider`, `Image`, `Icon`, `Transition`, and `Pending` must validate the props and children their renderers actually honor. A genuinely unknown Atom caused by version skew must remain visibly represented by `UnknownAtom` rather than crash or disappear.

This slice makes complex Surface composition trustworthy without opening free-form layout or styling. Unsupported behavior must be rejected explicitly, not stored and ignored.

## Acceptance criteria

- [ ] Each remaining known layout, media, motion, and loading Atom has a strict schema aligned with its renderer's supported semantics.
- [ ] Parent-child rules prevent invalid composition before Surface persistence while allowing the supported catalog to compose a non-trivial Surface.
- [ ] Accepted layout props produce an observable result without admitting raw CSS, arbitrary executable content, or generated HTML.
- [ ] Images and icons have validated sources, alternatives or labels, loading behavior, and truthful failure states.
- [ ] Transitions respect reduced-motion preferences and do not hide canonical content when animation is unavailable.
- [ ] Pending content remains visible, accessible, and replaceable by canonical terminal content without duplication.
- [ ] A known Atom with unsupported props or children fails before persistence rather than silently dropping them.
- [ ] A genuinely unknown Atom from protocol version skew renders a visible `UnknownAtom` fallback containing enough identity to diagnose the mismatch.
- [ ] A complex Surface using these families remains legible in supported viewport sizes and color schemes.
- [ ] Protocol and catalog tests cover valid composition, every rejection boundary, media failure, reduced motion, Pending replacement, and unknown-version fallback.
- [ ] A browser test proves a composed Surface neither crashes nor loses content after reload.
- [ ] `pnpm check` passes.

## Blocked by

- #142
