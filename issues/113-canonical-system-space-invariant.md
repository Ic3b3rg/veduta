# 113 — Make the canonical System Space an engine invariant

## Parent

#63

## What to build

Make the System Space's canonical identity and lifecycle an invariant shared across the protocol boundary and enforced by the Gateway.

There is exactly one System Space, identified only by the shared `spc-system` identity. Its name and slug are presentation values, never classification. The Gateway materializes or repairs it at boot and refuses lifecycle operations that could rename it, archive it, replace it through creation or import, or merge it as either source or target.

Do not introduce a parallel System Space schema, configurable kind flag, or generated UI path. The PWA may use the shared identity to position the System Space, while every Surface remains a normal validated Atom tree rendered through the catalog. User pinning and ordering remain ordinary evented presentation preferences.

Record the hard-to-reverse ownership and lifecycle boundary in an ADR and keep the domain glossary aligned. Because Veduta has no production installations yet, do not add a permanent legacy-content migration; existing development state will be reset after the implementation graph lands.

## Acceptance criteria

- [ ] The shared protocol exports the one canonical System Space identity, and Gateway code consumes that identity rather than a daemon-local duplicate.
- [ ] Boot creates a missing System Space with that identity and repairs an archived legacy instance without creating a second System Space.
- [ ] Rename, archive, merge-as-source, merge-as-target, creation, and import paths cannot mutate or replace the canonical System Space.
- [ ] Name and slug changes cannot cause a user-authored Space to be classified as System.
- [ ] Pinning and ordering daemon-owned System Surfaces remain allowed and append the required Space Events.
- [ ] The ADR and domain glossary state the singular identity, Gateway ownership, lifecycle rules, fixed-shell boundary, and no-production-migration decision.
- [ ] Focused protocol and Gateway lifecycle tests plus the full repository gate are green.

## Blocked by

None — can start immediately.
