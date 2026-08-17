# 035 — Seed fallback Surfaces only into existing Spaces

## Verified bug

The Store seeds Spaces and Surfaces under different conditions. When a data root already contains
at least one Space but has neither persisted Surface files nor rows in the Surface database, the
Space seed is skipped while the full fallback Surface seed is still applied. The Surface engine
then rejects the first fallback Surface whose owning Space was not created, and Gateway boot fails
with `unknown Space: spc-health`.

A focused reproduction against the current Store confirms the failure after creating one `Fitness`
Space in an otherwise empty data root.

## Desired behavior

Fallback seeding must be coherent across the Store boundary. A partially restored or independently
prepared data root must boot without inventing missing Spaces or assigning Surfaces across Space
boundaries. Existing Spaces and any rebuildable persisted Surface state remain authoritative.

## Acceptance criteria

- [ ] A data root containing at least one Space and an empty Surface database boots successfully.
- [ ] Fallback Surfaces are created only when their owning fallback Spaces exist.
- [ ] Persisted Surface files continue to rebuild the Surface database without being replaced by
      fallback state.
- [ ] A completely empty data root retains the current first-run seed behavior.
- [ ] Focused Store tests cover empty, partially seeded, restored, and ordinary existing roots.
- [ ] `pnpm check` passes.

## Out of scope

- Recovering genuinely corrupt Space files.
- Creating missing user Spaces from Surface identifiers.
- Changing the product's first-run seed content.

## Blocked by

None — can start immediately.
