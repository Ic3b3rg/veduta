# 064 — Route fixed PWA screens through one declarative client router

## Parent

#33

## What to build

Replace the fixed-screen navigation responsibilities currently split across local view state, pathname parsing, browser history calls, and service-worker message handling with one declarative client router.

The fixed route table covers:

- `/`
- `/setup`
- `/app/settings/models`
- `/app/space/:spaceSlug`
- `/app/space/:spaceSlug/surface/:surfaceId`

This slice establishes URL-addressable fixed screens, preserves the existing authentication and onboarding gates, and moves every navigation source onto the router API. The Space and Surface routes may preserve the current all-Spaces Home presentation until the next child ticket introduces the actual drill-down; their existing deep-link behavior must not regress during this prefactoring step.

Add a short ADR explaining why the growing fixed PWA shell now uses a declarative router, why the URL is the source of truth for fixed-screen selection, and why application routes remain outside Agent-maintained content.

## Architectural boundary

The route table is fixed application shell code. Spaces and Surfaces may supply route parameters and validated data, but Agent output cannot register, replace, or redefine a route.

This ticket does not introduce new Atom types or an alternative renderer. Surface trees continue to be validated by the protocol and rendered through the closed catalog.

## Acceptance criteria

- [ ] Directly loading or refreshing every documented path is recognized by the client router and resolves to the intended fixed screen after authentication and onboarding guards settle.
- [ ] The first-boot setup code in the query string survives until passkey registration succeeds, and completing onboarding navigates to `/`.
- [ ] Opening Model connections changes the URL to `/app/settings/models`; browser Back and Forward restore the matching screen.
- [ ] Service-worker `navigate` messages call the router navigation API instead of mutating browser history directly.
- [ ] The old local `view` switch is removed; fixed-screen selection has one URL-backed source of truth.
- [ ] Existing Space and Surface deep links remain usable while the dedicated drill-down ticket is pending.
- [ ] The ADR records the fixed-shell versus data-driven Surface boundary and the rejected hand-written history approach.
- [ ] Focused routing tests and the full repository gate are green.

## Blocked by

None — can start immediately.
