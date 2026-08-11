# Simplify repository code and durable documentation

Perform a behavior-preserving simplification pass across repository documentation, root tooling,
protocol, daemon, PWA, and the Atom catalog. Remove vendor-specific working plans, consolidate
duplicated primitives, and split modules whose multiple responsibilities impede maintenance.

`deploy/` and `packages/e2e/` are explicitly outside this issue.

## Acceptance criteria

- Durable documentation contains no agent-framework execution plan; project status, issue index,
  vocabulary, and comment references are current and mechanically checked where practical.
- Root test/runtime documentation and Node configuration describe the environment actually exercised
  by CI and releases.
- Repeated JSON, CLI, SQLite, Fastify, provenance, configuration I/O, and decision-Surface mechanics
  are centralized only where one shared contract exists, with focused tests.
- Gateway composition and large daemon services are decomposed behind stable public facades without
  weakening validation, Event log, trust, or AgentRunner boundaries.
- PWA API responsibilities, session reset behavior, storage helpers, Atom renderers, and feature CSS
  are decomposed with focused tests and stable public behavior.
- Existing lint, formatting, typecheck, unit/integration tests, and build pass without modifying deploy
  or E2E implementation files.

## Out of scope

- Changes under `deploy/`.
- Changes under `packages/e2e/`.
- New product behavior from open feature issues.

## Dependencies

None.
