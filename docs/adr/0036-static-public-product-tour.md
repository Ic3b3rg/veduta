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
