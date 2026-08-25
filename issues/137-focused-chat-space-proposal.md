# 137 — Focused chat cannot propose a new Space

## Context

Issue #136 added scoped multi-Space work and the existing one-tap Space proposal flow to global
chat. A focused chat intentionally receives the focused Space tool registry instead, which does not
expose the Space proposal capability.

The current shell still renders all Spaces on screen after a Space is selected. Selecting Health
changes the route to `/app/space/health` and the composer to `Message Health`, but there is no
explicit Home/global-chat control. A user can therefore reasonably believe the omnipresent chat can
still create another life-area Space.

## Confirmed behavior

1. Open Home.
2. Select Health.
3. Ask: `crea uno Space Lavoro`.
4. Veduta replies that no tool is available to create a Space.

The request cannot produce the existing `space-proposal` Pending decision because the focused
registry omits `propose_space`.

## What to build

An explicit request to create a new life-area Space uses the same durable, one-tap Space proposal
workflow from a focused chat. It must not create the Space or any initial Surface before trusted
user acceptance, and it must not grant focused chat broad cross-Space read or mutation
capabilities.

Acceptance or rejection preserves the current route and focused Space. The normal snapshot refresh
makes an accepted Space visible.

## Architectural boundary

The focused chat gains only the Gateway-owned Space proposal capability. It does not gain
`enter_space`, the scoped global registry, or authority to read or mutate any unrelated Space.
Creation continues through the existing `space-proposal` Pending-decision workflow so the trusted
user remains the only actor that can accept or reject it.

## Acceptance criteria

- [ ] From a focused user Space, asking to create a distinct new Space renders a pending
      `Create Space “…”` decision.
- [ ] No Space or Surface is created before acceptance; rejection creates nothing.
- [ ] Acceptance creates the Space exactly once, refreshes the visible Space roster, and leaves the
      current route and chat focus unchanged.
- [ ] Focused chat does not gain `enter_space` or tools for reading or mutating unrelated Spaces.
- [ ] The canonical System Space restrictions remain intact.
- [ ] The behavior is provider-independent and covered by focused-chat, Pending-decision, PWA, and
      real-browser regression tests.
- [ ] The full repository gate is green.

## Out of scope

- Adding the Home grid or explicit Home navigation tracked by #65 and #66.
- Automatically navigating into the newly accepted Space.
- Creating initial Surfaces before or as part of accepting the Space proposal.
- General cross-Space work from focused chat.

## Blocked by

- #136 — the shared global Space proposal and Pending-decision flow.
