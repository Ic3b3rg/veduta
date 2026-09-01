# 166 — Apply Precision Tool recipes to onboarding and Model connections

## Parent

#157 — [Adopt the product-first Precision Tool UI direction](https://github.com/Ic3b3rg/veduta/issues/157)

Canonical specification: [issues/157-product-first-precision-tool-ui.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/157-product-first-precision-tool-ui.md)

## What to build

Bring onboarding and Model-connection flows into the same Precision Tool language as the rest of the
PWA. First-run and configuration work should feel compact, familiar, and trustworthy across success,
loading, validation, migration, connection, and failure states without changing the underlying
security or setup behavior.

## Acceptance criteria

- [ ] Every onboarding step and Model-connection view uses the shared surface, control, field,
      status, focus, and spacing recipes rather than a parallel set of page-specific visual values.
- [ ] Durable setup content is opaque and high contrast; overlays or transient help use selective
      material only when context underneath is useful and include an opaque fallback.
- [ ] Step progress, required action, completion, warning, validation, connection, and failure
      states have distinct semantic hierarchy and do not depend on color alone.
- [ ] Inputs, secret fields, model selectors, connection controls, and navigation expose stable
      accessible labels, descriptions, disabled state, errors, and visible focus.
- [ ] Keyboard and screen-reader traversal follows the task order, and frequent controls meet the
      coarse-pointer target requirement.
- [ ] Long provider names, translated copy, empty connection lists, loading, rejected credentials,
      migration summaries, and narrow screens do not overlap, clip, or create horizontal overflow.
- [ ] Phone and desktop compositions share the same information hierarchy while adapting density
      and disclosure to the available space.
- [ ] Existing onboarding progress, connection storage, secret handling, provider capability, and
      navigation behavior remain unchanged.
- [ ] Component and browser tests cover representative first-run and returning-user states,
      keyboard behavior, errors, long content, and the supported reference widths.
- [ ] `pnpm check` passes.

## Blocked by

- #162
