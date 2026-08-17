# 117 — Retire synthetic System Surface projections

## Parent

#63

## What to build

Contract the legacy read-time System projection path after Model usage and Connected devices have moved onto persisted managers.

`GET /api/spaces` must return the validated Store snapshot plus request-independent attention metadata; it must not create a System Space, append System Surfaces, or refresh their content. Remove the synthetic append helper and prevent the Store's generic FACTS projection from manufacturing an ordinary Surface inside the System Space.

Inventory the resulting daemon-owned System Surfaces and prove that every visible one has a stable daemon-private identity, normal persistence, freshness, lifecycle Events, and live updates. The PWA continues to distinguish only the shared System Space identity and renders every contained Surface through the generic catalog.

This is the contract step that makes the System snapshot safe for the Home Space grid to consume for Surface counts and freshness.

## Acceptance criteria

- [ ] `/api/spaces` never synthesizes a System Space or appends or refreshes a System Surface while serving the request.
- [ ] The legacy System append helper and its request-time projection tests are removed.
- [ ] The canonical System Space contains no generic FACTS Surface and cannot acquire one through snapshot projection.
- [ ] Allowlist, Audit, Notification settings, Heartbeat, Reflection, Update, Model usage, and production Connected devices are inventoried as daemon-owned persisted Surfaces.
- [ ] Every visible System Surface is protocol-valid, has one stable daemon-private identity, and participates in normal persistence, freshness, Events, and live updates.
- [ ] Source failures leave the last valid Surface visible with explicit stale or error state rather than removing it.
- [ ] The PWA needs no Surface-ID switch, bespoke System renderer, generated route, or generated markup.
- [ ] Focused snapshot and live-convergence tests plus the full repository gate are green.

## Blocked by

- #114
- #115
