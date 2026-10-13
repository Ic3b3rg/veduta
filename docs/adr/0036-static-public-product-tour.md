# A public product tour is a separate static site

Status: accepted

## Context

Veduta needs a shareable demonstration before a visitor commits to self-hosting. Publishing the
unauthenticated Loopback profile or a personal Gateway would expose execution and configuration
capabilities. A shared mock Gateway would also need a separate visitor isolation and abuse model.

## Decision

The public guided tour is a dedicated static site. It reuses PWA presentation components and
protocol-validated, fictional scenario data. A closed sequence of sample requests demonstrates
Space confirmation, Surface creation, a Chat-driven edit and refresh. Each browser keeps only
the guided scenario stage in a namespaced local-storage key. No Gateway runtime or provider,
Service connection, shell tool or personal data is loaded. The site clearly discloses that
responses are scripted and persistence belongs to that browser.

The demonstration video uses the actual PWA and Gateway on loopback with temporary data and
the same scenario through the mock Model connection. Its recording verifies canonical content
after refresh and a Gateway restart. The video is evidence of production persistence paths;
the static tour is evidence of the interface. Neither establishes real-model or integration quality.

## Consequences

- The landing and tour can be hosted separately on a static host without a VPS or model bill.
- Visitors cannot access other visitors' state, configure credentials or invoke external effects.
- Clearing browser storage or changing devices loses the tour state; production persistence
  and passkey onboarding remain in the VPS and Local VPS profiles.
- Arbitrary requests, integrations and Automations are outside the guided tour. A future public
  real-model service needs its own authentication, isolation, authorization and cost decision.

Operational instructions and the storyboard live in [the demo guide](../DEMO.md).

## Amendment: shared product shell (2026-10-13)

The tour renders the same `AppShell`, router, Space navigation, Surface presentation and responsive
`ChatPanel` as the PWA. Sharing individual content components inside a separate tour layout does
not meet the visual-fidelity requirement. Tour CSS may style its collapsible announcement only;
product geometry, breakpoints, scroll behavior and mobile Chat remain owned by the PWA.

The live PWA supplies notification and installation controls to the presentation shell. The static
tour never mounts those native/Gateway effects. Its closed state is projected into validated Space,
Surface, Chat and Pending-decision data, with separate Global and Work conversations. Work is
accepted or rejected using the product's existing Pending-decision controls, then opened through
its normal result link. A small guide supplies sample prompts, disclosure and Reset without
replacing product navigation. Reset also remounts the shell to clear transient Chat drafts.

A push to `main` rebuilds the static site from the shared sources, carrying product presentation
changes into the tour. New behavior can still require changes to the simulated data. This amendment
changes only the interactive tour; existing video and screenshot assets remain recorded evidence.
