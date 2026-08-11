# Domain Docs

This repository uses a single-context domain layout shared by all monorepo packages.

## Before exploring

- Read `CONTEXT.md` at the repository root.
- Read the ADRs under `docs/adr/` that affect the work.
- Consult `ARCHITECTURE.md` and `docs/SECURITY.md` when the work touches architecture, trust,
  authentication, or external effects.
- Proceed silently if a referenced document does not exist.

## Layout

- `CONTEXT.md` defines the shared domain vocabulary.
- `docs/adr/` contains repository-wide architectural decisions.
- `packages/` contains implementations that consume the same domain language and decisions.
- No package-specific `CONTEXT.md` or ADR hierarchy is currently used.

## Vocabulary

Use the exact concepts defined by `CONTEXT.md` in issue titles, specifications, code, tests, and
review findings. Do not use synonyms listed under `_Avoid_`.

If a necessary concept is absent, reconsider whether existing vocabulary already covers it. Record
a genuine domain gap through `/domain-modeling`.

## ADR conflicts

Surface any conflict with an existing ADR explicitly. Do not silently override or reinterpret an
accepted decision.
