# 106 — Make pinned Surfaces prominent with Gateway-owned ordering

## Problem Statement

Pin currently protects a Surface's composition but does not make that Surface visibly prominent.
From the user's perspective, pressing Pin only changes the button state: the Surface stays where it
was, may remain below unrelated Surfaces, and is not brought into view. This conflicts with the
well-established meaning of pinning in messaging products, where a pinned item occupies a dedicated
area at the top.

Surface order is also currently a browser-local preference. Two browser sessions can therefore show
the same Space in different orders, and a fresh session cannot reconstruct the user's arrangement.
Pin and Unpin make that split ownership worse because they move a Surface between prominent and
regular content. No browser-local order can be the trustworthy cross-browser authority.

The user needs Pin to mean both "keep this composition stable" and "keep this Surface prominent",
without losing the existing Template, state-update, and Tree-proposal guarantees.

## Solution

Give every Space two Gateway-owned ordered groups: Pinned and regular Surfaces. Render Pinned first
and only while it contains at least one Surface. A successful Pin moves the Surface to the beginning
of Pinned; a successful Unpin moves it to the beginning of the regular group. A newly created Surface
also enters at the beginning of the regular group. Users can move Surfaces up or down within their
current group, while only Pin and Unpin may cross the group boundary.

Make the Gateway the single durable authority for both groups. Snapshots, mutation responses,
replayed events, and live events expose one canonical order to every browser. Relative Move commands
are serialized against the Gateway's current order. Existing installations receive a deterministic
backfill from durable Surface events, never from whichever browser connects first, and former
browser-local orders are discarded once the authoritative snapshot arrives.

Keep order mutations non-optimistic and online-only. The PWA retains the last confirmed order while
a request is pending or fails. A Pin directly initiated from the current tab scrolls the confirmed
Surface to the viewport centre and briefly highlights it; Unpin, Agent-driven Pin, remote-client
updates, and replay never move the viewport. Respect reduced-motion preferences and do not change
the current route, selected Surface, or keyboard focus.

## User Stories

1. As a Home user, I want a pinned Surface to appear in a dedicated group at the top of its Space, so that Pin has an immediately visible meaning.
2. As a Home user, I want the Pinned group to appear before every regular Surface, so that important Surfaces remain prominent.
3. As a Home user, I want the most recently pinned Surface to appear first in Pinned, so that the Surface I just prioritized is easiest to find.
4. As a Home user, I want a successful direct Pin to bring the Surface into view, so that I can see the result even when the card began below the viewport.
5. As a Home user, I want the directly pinned Surface to receive a brief visual highlight, so that I can identify what moved after the layout changes.
6. As a keyboard user, I want Pin to preserve my current keyboard focus, so that visual repositioning does not interrupt my interaction.
7. As a user following a deep link, I want Pin to preserve my current route and selected Surface, so that prominence does not become navigation.
8. As a user who prefers reduced motion, I want Pin positioning to happen without smooth animation and with a non-animated highlight, so that the feedback respects my accessibility preference.
9. As a Home user, I want Unpin to remove prominence without scrolling or highlighting, so that removing a Pin is quiet and predictable.
10. As a Home user, I want an unpinned Surface to appear first in the regular group, so that it remains easy to find immediately after leaving Pinned.
11. As a Home user, I want a new regular Surface to appear first in the regular group, so that newly created work is visible without outranking a Pin.
12. As a Home user, I want to move a pinned Surface up or down within Pinned, so that I can replace the default last-pinned-first order with my preferred order.
13. As a Home user, I want to move a regular Surface up or down within the regular group, so that all Surface ordering follows one consistent model.
14. As a Home user, I want Move controls disabled at the beginning and end of their group, so that a Move can never cross the Pinned boundary accidentally.
15. As a Home user, I want only Pin and Unpin to move a Surface between groups, so that group membership is always explicit.
16. As a Home user, I want repeated Pin on an already pinned Surface to do nothing, so that a duplicate request cannot unexpectedly move it to the top.
17. As a Home user, I want repeated Unpin on a regular Surface to do nothing, so that duplicate requests cannot disturb my regular order.
18. As a Home user, I want manual order to remain authoritative after I arrange Pinned, so that a later reload does not restore last-pinned-first order.
19. As a user with many important Surfaces, I want no numeric Pin limit, so that composition protection never becomes unavailable because of presentation policy.
20. As a Home user, I want an empty Pinned group to consume no layout space, so that Spaces without Pins remain uncluttered.
21. As a Home user, I want an empty regular group to consume no layout space, so that a Space containing only Pins has no dead area.
22. As a Home user, I want the existing No Surfaces state only when both groups are empty, so that an empty message never appears beside real content.
23. As a Home user, I want the Pinned heading to show its count, so that the dedicated group's size is clear at a glance.
24. As a multi-device user, I want every browser to render the same Surface order, so that my Home does not depend on which device I open.
25. As a multi-device user, I want a Pin, Unpin, or Move accepted in one browser to update other connected browsers, so that all sessions converge live.
26. As a multi-device user, I want remote ordering updates to leave my viewport alone, so that another browser cannot hijack what I am reading.
27. As a returning user, I want the authoritative order to survive Gateway restarts and browser reloads, so that arranging a Space is durable.
28. As a user opening a fresh browser, I want the first snapshot to contain the same order as existing sessions, so that no browser-local setup is required.
29. As a user reconnecting after missing events, I want replay or snapshot reconciliation to restore the canonical order, so that transient disconnection cannot create a permanent divergence.
30. As an offline user, I want the last confirmed order to remain visible, so that Home stays readable without pretending a mutation succeeded.
31. As an offline user, I want Pin, Unpin, and Move to report that they are unavailable instead of being queued, so that an old command cannot replay later against a different order.
32. As a user performing an online order mutation, I want the affected control to show pending state and reject duplicate input, so that one gesture produces at most one accepted change.
33. As a user whose order mutation fails, I want the visible order to remain unchanged and the error to be shown, so that the UI never lies about Gateway state.
34. As a user moving a Surface while another session is active, I want the Gateway to apply my relative Move against its current order, so that clients do not overwrite one another with stale whole-list replacements.
35. As a user, I want ordering commands to be serialized without a visible conflict-resolution workflow, so that ordinary Move interactions remain simple.
36. As a user of an upgraded installation, I want a deterministic initial shared order, so that migration does not choose an arbitrary browser's preference.
37. As a user of an upgraded installation, I want currently pinned Surfaces initially ordered by their latest accepted Pin, newest first, so that the backfill matches the agreed default.
38. As a user of an upgraded installation, I want regular Surfaces initially ordered by their latest creation or Unpin, newest first, so that recent regular work remains easiest to find.
39. As a user of an installation with incomplete legacy history, I want a stable fallback order, so that every active Surface still appears exactly once.
40. As a user with an old browser-local order, I want the Gateway snapshot to replace it decisively, so that conflicting local preferences do not undermine the shared authority.
41. As a user, I want archiving a Surface to remove it from the active order, so that stale ordering records cannot leave an invisible placeholder.
42. As a user with multiple Spaces, I want each Space's two groups ordered independently, so that arranging one life area cannot disturb another.
43. As a user, I want Pin to keep locking the Surface tree while state continues updating, so that visual prominence does not weaken composition protection.
44. As a user, I want Pin to keep saving the Surface composition as a Template, so that the existing emergent-Template behavior remains intact.
45. As a user, I want an Agent-driven Pin to update shared prominence without scrolling any browser, so that Agent work cannot unexpectedly move my viewport.
46. As a user, I want only a human-authenticated action to Unpin, so that the Agent cannot remove the tree protection that constrains it.
47. As a user relying on assistive technology, I want group headings and Move boundaries to be expressed accessibly, so that the visual grouping is also understandable without sight.
48. As a user, I want every accepted Pin, Unpin, and Move to appear in the Space's Event log, so that the Agent can find my interactions before reasoning about the Space.

## Implementation Decisions

- The scope is pinned prominence plus the authoritative Surface ordering required to support it. It does not change Template matching, Template instantiation, direct Surface creation policy, or the accepted Tree-proposal workflow.
- Every Space has exactly two ordered active-Surface groups: Pinned and regular. The existing pinned state determines membership; persisted ordering determines position within the matching group. Every active Surface appears exactly once.
- The Gateway owns and persists both groups. The PWA no longer owns a separate Surface-order preference and never promotes local storage into shared state.
- Gateway snapshots expose Surfaces in canonical group and position order. The protocol also exposes an authoritative, cursor-ordered live/replay result for every accepted ordering change so clients can converge without a refetch in the normal path.
- The PWA derives the two rendered sections from validated Gateway state. It preserves order within each group and does not independently merge, sort, or repair a user preference.
- A new Surface is inserted first in the regular group. Archiving removes it from the active order. Pin inserts first in Pinned; Unpin inserts first in regular.
- Pin and Unpin are strict state transitions. A request whose target already has the requested state returns the current authoritative result without writing storage, bumping freshness, appending an Event, saving another effective ordering change, or broadcasting a mutation.
- Pin continues to save the composition as a Template when it performs a real regular-to-pinned transition. Existing Template idempotency remains unchanged.
- Manual ordering uses an authenticated relative Move command containing the target Surface and one-step direction. Clients never submit a replacement ordered list.
- The Gateway validates that the target is active, belongs to the stated Space, and moves only within its current group. It serializes accepted commands against the latest persisted order in one write boundary.
- The mutation response and live event carry enough authoritative result data for the initiating client and every observer to render the same order even when HTTP and WebSocket delivery race. Applying the same confirmed result more than once is harmless.
- Every effective Pin, Unpin, and Move appends a domain entry to the owning Space's Event log. Realtime ordering events remain distinct from the durable Space Event log, matching the existing Gateway architecture.
- No user-visible revision-conflict flow is introduced. Relative commands avoid stale whole-list replacement; the Gateway's serialization order is the result.
- Pin, Unpin, and Move are online-only and are excluded from PWA offline queues. While a request is pending, the PWA keeps the last authoritative state and disables the affected ordering control. Failure preserves the prior order and displays an error.
- A direct Pin initiated by the current tab waits for Gateway confirmation, then scrolls the rendered Surface to the viewport centre and applies a brief local highlight. This visual effect is not persistent shared state.
- Direct Unpin never scrolls or highlights. Agent-driven, remote-client, and replayed Pin events update order without scrolling or highlighting.
- Pin feedback does not change the route, the selected Surface, or keyboard focus. Smooth scrolling and animated highlighting are disabled when the user prefers reduced motion; positioning remains immediate and the highlight remains visible without animation.
- Pinned is rendered before regular Surfaces. A group is rendered only when non-empty. A wholly empty Space retains the existing No Surfaces state. Pinned includes an accessible label and count.
- Existing Move up/down controls remain the ordering interaction for the first version. They operate only inside one group and are disabled at group boundaries.
- There is no numeric limit on Pinned.
- The first Gateway-owned order for an existing installation is backfilled deterministically from durable Surface history. Pinned uses latest accepted Pin newest first; regular uses latest creation or Unpin newest first; incomplete ties or missing history use a stable Surface-id fallback.
- Backfill runs only when authoritative ordering is absent and is restart-safe and idempotent. Once authoritative order exists, Event history is not used to overwrite manual arrangement.
- After a canonical snapshot arrives, obsolete browser-local Surface-order data is ignored and removed. Cached Home data may retain the latest canonical snapshot for offline reading but is never an ordering authority.
- Existing security boundaries remain: authenticated human routes may Pin and Unpin; the Agent tool may Pin but may not Unpin; daemon-owned non-pinnable Surfaces remain excluded.

## Testing Decisions

- Tests assert observable contracts rather than internal arrays, SQL statements, component implementation, or CSS selectors chosen only for styling.
- The primary acceptance seam is a real-browser Playwright journey against a real Gateway. Two isolated browser sessions prove canonical grouping, cross-client convergence, reload persistence, quiet remote updates, local Pin focus, Move boundaries, Unpin placement, pending/error behavior, offline refusal, and reduced-motion behavior.
- Browser assertions use accessible roles, labels, group headings, and visible Surface order. Visual focus is asserted through the Surface's observable position and highlight state without requiring keyboard focus or route changes.
- The Gateway integration seam uses the existing HTTP injection, WebSocket observation, and real Store setup. It proves canonical snapshots, relative Move serialization, idempotent Pin/Unpin, authoritative mutation responses, replay, Event-log entries, and restart persistence.
- Migration coverage boots representative pre-order data with Pin, creation, Unpin, tie, incomplete-history, and archived-Surface cases; it asserts the public snapshot and Event behavior after migration rather than the storage representation.
- Protocol validation is exercised at the Gateway boundary for snapshots, commands, and live/replayed events, including rejection of unknown, archived, cross-Space, and cross-group targets.
- Idempotency tests prove repeated Pin and Unpin do not change ordering, freshness, cursor, Template count, or Space Event-log length.
- Serialization tests issue relative commands from independent clients and assert the one canonical resulting snapshot and event sequence, without testing a user-visible conflict dialog that does not exist.
- Prior art is the existing Pin route and WebSocket coverage, the existing pre-Template database migration fixtures, the PWA app-level live-state tests, and the Local VPS Playwright journey with restart and Space Event-log assertions.
- Focused test commands should be used during red-green implementation. Completion requires `pnpm check`; the real-browser E2E remains a separate explicit verification because it is not part of `pnpm test`.

## Out of Scope

- ChatGPT-subscription Template reuse or any other work owned by issue #76.
- Changes to Template matching, harvesting, import/export, provenance, or direct-create justification.
- Changes to tree locking, state patching, Tree-proposal review, or Agent authorization beyond preserving their current Pin behavior.
- Scrolling or highlighting a Surface created by a local chat turn; that is a separate follow-up concern.
- Drag-and-drop, arbitrary position inputs, or cross-group Move commands.
- A numeric Pin limit, automatic eviction, or collapsing excess pinned Surfaces.
- Queuing Pin, Unpin, or Move while offline.
- Optimistic ordering, client-authored whole-list replacement, or a visible order-conflict workflow.
- Turning Pin into navigation, selection, or keyboard-focus movement.
- Reordering across Spaces or defining one installation-wide Surface order.
- Rich Pin controls in messenger Bridges.

## Further Notes

- This specification builds on the closed Home and emergent-Template work in issues #9 and #22 and records the accepted prominence semantics in ADR-0012.
- The previous issue #76 implementation remains independent: it proves Template-tool parity through a ChatGPT subscription, while this specification changes how all clients present and order accepted Pin state.
- The implementation handoff must include a concise manual UI test script covering direct Pin, manual Move, Unpin, reload, two browser sessions, offline failure, and reduced motion.
- This specification is intended to become the parent for tracer-bullet implementation tickets created by the next `$to-tickets` phase.

## Implementation tickets

- #108 — canonical Gateway-owned order.
- #109 — accessible pinned and regular groups.
- #110 — confirmed online-only ordering mutations.
- #111 — initiating-tab direct-Pin reveal.
- #112 — convergence and recovery evidence.

## Parent completion criteria

- [ ] Issues #108 through #112 are complete.
- [ ] Pin prominence, ordering authority, mutation feedback, and cross-client recovery satisfy this
      specification.
- [ ] The full repository gate and owning browser E2E are green.
