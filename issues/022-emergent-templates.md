# 022 — Emergent Templates

## Context

[ADR-0003](../docs/adr/0003-declarative-atoms.md): good compositions get saved and reused — consistency across regenerations, the basis of the future community registry.

## Goal

The Agent reuses its own compositions instead of reinventing them, and the user can lock them.

## Tasks

- Saving: when a Surface stabilizes (N days without tree restructurings, or an explicit user pin), the tree (without data) becomes a Template in the Space
- Reuse: when creating a similar Surface (match on intent/type), the Agent starts from the Template and patches the data in; regenerating "from scratch" requires a justification
- User pin: "I like this Surface as it is" → the tree is locked, the Agent can only patch the state (tree patches become proposals with a preview)
- Export/import of Templates as JSON (the seed of the post-v1 registry)

## Acceptance criteria

- Recreating a similar tracker in another Space, the Agent reuses the Template (assert on provenance)
- Pinned Surface: an Agent tree patch becomes a proposal, the state keeps updating
- An exported Template imports into another installation and populates with local data

## Dependencies

007, 008
