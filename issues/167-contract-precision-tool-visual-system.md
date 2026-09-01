# 167 — Contract the legacy visual system and prove Precision Tool end to end

## Parent

#157 — [Adopt the product-first Precision Tool UI direction](https://github.com/Ic3b3rg/veduta/issues/157)

Canonical specification: [issues/157-product-first-precision-tool-ui.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/157-product-first-precision-tool-ui.md)

## What to build

Complete the contract phase after every product region uses the Precision Tool recipes. Remove the
legacy light-theme and broad glass/glow promises, prove the entire deterministic inventory and real
PWA at the supported reference widths, and make the visual contribution gate enforceable for future
features.

This ticket is the integration and deletion boundary: it must leave one visual system and must not
hide behavior regressions behind regenerated screenshots.

## Acceptance criteria

- [ ] Production PWA and catalog consumers use the approved semantic recipes, with page-specific
      values retained only when no reusable role exists and the rationale is documented.
- [ ] Legacy broad-glass, decorative-glow, ambient-gradient, universal-pill, broad-blur, and
      unsupported light-theme aliases, branches, fixtures, metadata, and tests are removed rather
      than left as a second visual contract.
- [ ] Operating-system light preference cannot select an unsupported light appearance; application
      metadata, installation surfaces, contributor documentation, and deterministic fixtures all
      state and render the supported dark appearance consistently.
- [ ] Every remaining translucent region is transient, has a concrete contextual purpose, is not
      nested across adjacent content, and is verified with its fully usable opaque fallback.
- [ ] The deterministic inventory covers shell, Home, Space detail, Surface chrome, Chat, Pending
      decisions, onboarding, Model connections, every Atom, and every required representative state.
- [ ] Reviewable evidence at 320-pixel phone and 1440-pixel desktop widths shows no horizontal
      overflow and records the semantic reason for every accepted baseline change.
- [ ] Keyboard traversal, visible focus, text reflow, control and state contrast, color-independent
      meaning, coarse-pointer targets, reduced motion, increased contrast where supported, and
      opaque fallback pass their relevant automated and browser checks.
- [ ] Real-browser observations show no broad blur, layout-triggering animation, or material
      responsiveness regression on the phone path.
- [ ] Regression coverage proves direct routes, route recovery, qualifying reveal, Atom actions,
      ordering actions, Agent updates, and Pending decisions retain their established behavior.
- [ ] The contribution gate requires each material UI change to name the hierarchy or state it
      improves, use or extend a shared recipe, show phone and desktop evidence, cover affected
      accessibility behavior, and explain any visual-baseline update.
- [ ] The complete repository gate and owning browser E2E pass.
- [ ] `pnpm check` passes.

## Blocked by

- #163
- #164
- #165
- #166
