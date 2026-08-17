# 069 — Make the complete Home and Space journey work on narrow viewports

## Parent

#33

## What to build

Finish the routed Home and Space experience for narrow viewports after the complete card, approval, and activity composition exists.

Use one responsive composition of the same fixed-shell components: the Home grid becomes a single column, the Space rail becomes collapsible behind an accessible control or an equally explicit narrow-screen navigation pattern, and the selected Space fills the available width with a consistently reachable Home control.

Approval summaries, attention signals, activity dots, card metadata, and the global chat must remain readable and operable without horizontal overflow. Verify the completed journey in a real browser on desktop and mobile-sized viewports.

## Architectural boundary

Desktop and mobile use the same route model, Space data, Surface objects, and catalog renderer. Do not create a second mobile Surface renderer, reduce an Atom tree into a separate representation, or fork domain-specific mobile components.

Responsive shell components continue to use catalog-derived design tokens and preserve the accessibility guarantees of the Atom content they contain.

## Acceptance criteria

- [ ] The Home grid is a single readable column on narrow viewports with no horizontal page overflow.
- [ ] Space navigation is collapsible or equivalently compact, keyboard-operable, and exposes its expanded state to assistive technology.
- [ ] A Space route is full-width and always offers an explicit route back to Home.
- [ ] Approval strip, approval counts, server attention, activity dots, freshness, and Surface counts remain legible at narrow widths.
- [ ] Surface controls retain usable tap targets and the global chat does not cover essential content.
- [ ] Desktop and mobile use the same validated Surface and catalog-rendering path.
- [ ] A real-browser journey verifies Home grid → Space → Surface → Back, plus direct load, refresh, and browser Back/Forward.
- [ ] The full repository gate and the relevant real-browser suite are green.

## Blocked by

- #67
- #68
