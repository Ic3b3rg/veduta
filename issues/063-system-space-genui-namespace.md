# 063 — Make the System Space a singular engine-owned GenUI namespace

## Context

Discovered while decomposing #33. Veduta already has one canonical System Space, and its daemon-owned Surfaces are protocol-valid Atom trees rendered by the same catalog as every other Surface.

The stronger invariant is not fully enforced today: canonical identity is daemon-local, generic lifecycle and Agent paths can still target the System Space, generic snapshots manufacture a FACTS Surface there, and Model usage and Connected devices are appended while serving a snapshot instead of participating in the normal Surface lifecycle.

## Resolved contract

- Exactly one System Space exists, is always active, and is identified only by the shared protocol identity `spc-system`. Name and slug are presentation, never classification; there is no configurable kind flag or parallel System Space model.
- The Gateway owns its lifecycle and content. Boot may create a missing instance or repair an archived development instance. Ordinary creation, import, rename, archive, and merge operations cannot replace it or target it as either merge participant.
- The Agent cannot create ordinary Surfaces, write FACTS or INSTRUCTIONS, or author Automations there. System-scoped chat remains available with safe status reads and explicit Gateway operations; personal-content requests redirect to a user life-area Space.
- User pinning and ordering remain allowed as validated, evented presentation preferences. Actions explicitly exposed by daemon-owned Surfaces remain available.
- Every visible System Surface is daemon-owned durable living state with a stable daemon-private identity. It is validated, persisted, refreshed, recorded in the Space Event log, and delivered through normal live updates.
- A failed refresh retains the last valid Surface, visibly records stale or error state and the last successful timestamp, and repairs that same Surface in place after recovery.
- The PWA may use only the shared System Space identity to place it in a secondary fixed-shell group. It never interprets individual Surface identities or introduces a bespoke System renderer, generated route, or generated markup.
- There are no production installations requiring compatibility migration. Do not add permanent recovery machinery for legacy development data; reset local state after the implementation graph lands.

The durable rationale is recorded in [ADR-0020](../docs/adr/0020-singular-engine-owned-system-space.md).

## Current-state inventory

Already persisted through Surface managers:

- Allowlist
- Audit
- Notification settings
- Heartbeat
- Reflection
- Update

Read-time projections to migrate:

- Model usage
- Connected devices in production-auth mode

The generic FACTS projection must not apply to the System Space.

## Implementation graph

- #113 establishes the shared identity, lifecycle guards, and documented engine invariant.
- #114 and #115 independently migrate Model usage and Connected devices after #113.
- #116 enforces Gateway-only authoring after #113 and may proceed in parallel with those migrations.
- #117 removes the synthetic projection path after #114 and #115.
- #117 replaces this analysis issue as the System-state blocker for the Home grid in #66. Agent-authoring enforcement in #116 is part of this parent but does not block that PWA slice.

All five implementation tickets are native sub-issues of this parent and carry `ready-for-agent`.

## Parent completion criteria

- [ ] The five implementation sub-issues are complete.
- [ ] The canonical System Space has one normal persistence, Event, freshness, and live-update path for every visible Surface.
- [ ] Local pre-production development state has been reset and the clean first-run state verified.
- [ ] The full repository gate is green.

## Blocked by

None — analysis is complete and the implementation frontier starts at #113.

## References

- [Veduta domain language](https://github.com/Ic3b3rg/veduta/blob/main/CONTEXT.md)
- [ADR-0002: hierarchy lives in Spaces](https://github.com/Ic3b3rg/veduta/blob/main/docs/adr/0002-single-agent-spaces.md)
- [ADR-0003: Surfaces are declarative Atom trees](https://github.com/Ic3b3rg/veduta/blob/main/docs/adr/0003-declarative-atoms.md)
- [Issue #33: Home Space grid and drill-down](https://github.com/Ic3b3rg/veduta/issues/33)
