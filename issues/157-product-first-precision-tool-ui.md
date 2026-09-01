# 157 — Adopt the product-first Precision Tool UI direction

## Problem Statement

Veduta's current PWA presentation gives too many regions the same rounded, translucent, elevated
treatment. The result weakens hierarchy, makes durable Surface state compete with shell chrome,
and can resemble a generic synthetic product even though Veduta has a specific home-first model.
The product needs to feel like a precise instrument for operating Spaces and living Surfaces, not
like a themed collection of interchangeable cards.

An accepted prototype has established a stronger direction: compact dark chrome, opaque content,
crisp separators, predictable controls, quieter decoration, and denser information. It also exposed
a governance problem. Many product capabilities are still evolving, so a one-off reskin would
quickly drift unless future UI changes share semantic tokens, component recipes, behavioral
boundaries, representative states, and repeatable visual evidence.

The visual change must not silently alter Veduta's product contract. Space and Surface routes,
Gateway-confirmed ordering, fast-path behavior, Agent-authored updates, Pending decisions, keyboard
focus, and the closed Atom catalog remain authoritative. Phone and desktop are both primary
devices, and the interface must remain usable with long, empty, stale, loading, error, and changing
content rather than only an ideal seed state.

## Solution

Adopt the approved **Precision Tool** direction as Veduta's product UI baseline and encode it as a
durable visual-language contract rather than freezing one screenshot pixel for pixel.

The supported appearance for this phase is dark-only. Durable Space and Surface content uses
opaque, low-elevation planes with disciplined density, restrained radii, crisp dividers, and one
cool operational accent plus separate semantic state colors. Translucency is optional and reserved
for a small interaction layer where preserving visible context has a concrete purpose; every such
region must remain fully usable with an opaque fallback. Gradients, glow, large pill shapes, and
ambient motion are not default decoration.

The product's real objects and state create its character: Space identity, Surface hierarchy,
freshness, attention, Pending decisions, Agent activity, and localized updates. Chat stays always
available as the editing tool without visually outranking Home or the active Space. Controls use
the compact geometry, accessible labeling, visible focus treatment, and predictable state behavior
associated with shadcn-style component patterns, but this issue does not add shadcn as a dependency
or create a second design system.

Promote the approved prototype decisions across the PWA shell, Home, Space detail, Surface chrome,
chat, onboarding, and connection flows. Add a durable visual-language document, semantic component
recipes, a deterministic reference inventory covering real product states, and contribution gates
that future UI changes must satisfy before they are accepted.

## User Stories

1. As a Veduta user, I want the interface to foreground my Spaces and living Surfaces, so that the
   product's purpose is apparent before I interact with chat.
2. As a returning user, I want stable navigation and action placement, so that Agent-authored state
   changes do not make the product feel newly generated on every visit.
3. As a desktop user, I want width used for parallel context and readable density, so that I can
   inspect and operate more state without receiving oversized empty cards.
4. As a phone user, I want one clear job at a time with thumb-reachable controls, so that the same
   product remains practical on a narrow screen rather than becoming a scaled-down desktop.
5. As a user reading durable state, I want Surface content on solid, high-contrast planes, so that
   text and controls remain legible and visually distinct from temporary interaction chrome.
6. As a user scanning Home, I want Space name, freshness, attention, Pending decisions, and Surface
   count to have a consistent hierarchy, so that I can identify what matters at first glance.
7. As a user entering a Space, I want its current route and selected Surface to be unambiguous, so
   that navigation state never depends on decorative emphasis alone.
8. As a user following a direct Surface link, I want the route-derived Surface to be identified and
   reachable without a separate manual Focus command, so that deep links remain deterministic.
9. As a user whose initiating Agent turn creates a Surface, I want that Surface revealed with
   localized feedback, so that a successful change is perceptible without rearranging unrelated
   content.
10. As a user whose initiating Agent turn creates a Pending decision, I want the decision revealed
    in the correct product region, so that required attention is visible without chat taking over
    the page.
11. As a user operating an Atom, I want the action to preserve the current URL, selected Surface,
    scroll context, and keyboard focus unless its established product contract explicitly says
    otherwise, so that routine work does not cause surprising navigation.
12. As a user reordering a Surface, I want Move Up and Move Down grouped on the left of the Surface
    toolbar, so that ordering actions occupy one predictable location.
13. As a user pinning a Surface, I want a recognizable thumbtack action on the right of the toolbar,
    so that prominence is communicated without a wide text button.
14. As a keyboard or assistive-technology user, I want the Pin control to keep a stable accessible
    name and expose its state separately, so that toggling it does not change the control's identity.
15. As a keyboard user, I want visible focus indicators and logical traversal order, so that compact
    controls do not reduce operability.
16. As a touch user, I want frequent controls to meet a 44-by-44-pixel target on coarse pointers, so
    that visual density does not produce fragile interactions.
17. As a user, I do not want a visible Focus action on every Surface, so that system-driven reveal
    semantics are not exposed as redundant card furniture.
18. As a user, I want system- or Agent-driven reveal to remain programmatic and event-specific, so
    that Surface creation and decisions can guide attention without turning every action into
    navigation.
19. As a user, I want the Veduta wordmark to be direct and quiet, so that ornamental status dots or
    environment copy such as "Loopback profile" do not compete with product state.
20. As a user managing Model connections and notifications, I want compact, familiar controls with
    accessible labels, so that shell utilities remain discoverable without dominating the top bar.
21. As a user editing through chat, I want chat always available but visually subordinate to Home
    and the active Space, so that conversation remains a tool for changing persistent state.
22. As a user, I want success, warning, danger, offline, queued work, freshness, and attention to use
    distinct semantic treatments, so that color and elevation communicate product meaning rather
    than decoration.
23. As a user with reduced-motion preferences, I want nonessential movement removed while reveal
    and update state remain perceptible, so that accessibility does not erase important feedback.
24. As a user on a lower-powered phone, I want the interface to avoid broad blur, ambient animation,
    and paint-heavy effects, so that visual polish does not compromise responsiveness or battery.
25. As a user with long or translated content, I want headings, metadata, controls, and Surface
    content to wrap or truncate intentionally without overlap, so that the geometry survives real
    data.
26. As a user encountering empty, loading, stale, error, offline, or Pending states, I want each
    state to retain the same hierarchy and component quality as the happy path, so that the product
    remains trustworthy when conditions change.
27. As a contributor, I want visual decisions expressed through semantic tokens and shared
    component recipes, so that future changes improve the system instead of accumulating page-level
    exceptions.
28. As a contributor, I want one deterministic reference inventory containing shell states and the
    complete Atom catalog with realistic data, so that I can compare UI changes against the same
    evidence on phone and desktop.
29. As a contributor, I want every visual change to declare which product state or hierarchy it
    improves, so that unearned gradients, glow, pills, shadows, blur, and motion can be rejected
    before they spread.
30. As a maintainer, I want browser evidence, accessibility checks, and performance observations for
    material or motion changes, so that approval is based on behavior and representative rendering
    rather than a single polished screenshot.
31. As a maintainer, I want future feature tickets to preserve the visual-language contract while
    extending it through shared components, so that upcoming Surface and chat capabilities do not
    fragment the PWA.
32. As a product owner, I want changes to information hierarchy, Home content, Agent behavior, or
    Surface semantics surfaced as product decisions, so that a visual refresh cannot quietly break
    the accepted home-first architecture.

## Implementation Decisions

- **Direction:** Precision Tool is the accepted territory. It is compact, operational,
  information-dense, dark, and state-led. Personal language and readable Surface content keep it
  from becoming a trading terminal.
- **Theme:** dark is the only supported product appearance for this phase. Theme wiring,
  documentation, fixtures, and tests must stop promising or assuming a supported light appearance.
  High contrast remains an accessibility requirement inside the dark theme.
- **Material boundary:** durable content is opaque by default. Selective translucency is allowed
  only for transient or floating interaction chrome when seeing context beneath it helps the task;
  it must have an opaque fallback and may not be nested across adjacent content regions.
- **Geometry:** content groups use restrained shared radii, thin dividers, modest elevation, and
  compact spacing. Buttons, inputs, menus, status labels, cards, and overlays use named recipes so
  the same role has the same geometry across the PWA.
- **Decoration budget:** gradients, glow, universal pill shapes, large soft shadows, animated
  backgrounds, parallax, ambient drift, and repeated shimmer are prohibited defaults. A future use
  must encode a specific state or interaction and provide accessibility and performance evidence.
- **Color:** one cool accent identifies interaction and selected state. Success, warning, danger,
  freshness, attention, offline, and Pending decision treatments remain semantic and may not depend
  on color alone.
- **Typography and density:** use a disciplined operational scale, tabular numerals where values
  align, and restrained metadata. Desktop gains parallel context; phone progressively discloses
  secondary metadata. Density must not reduce touch targets, readable line length, or focus clarity.
- **Shared ownership:** colors, typography, spacing, motion, and shared materials deepen the
  existing catalog token boundary. Shell-only roles remain explicitly separated. Page-specific
  values are permitted only when no reusable semantic role exists and the reason is documented.
- **Component approach:** use shadcn as interaction and geometry inspiration—clear anatomy,
  predictable variants, accessible names, explicit states, and composable shared controls—without
  importing its visual defaults, adding it as a dependency, or bypassing the closed Atom catalog.
- **Prototype baseline:** preserve the approved shell simplification, denser Home cards, quieter
  Space rail, opaque Surface treatment, compact utilities, responsive chat, and removal of broad
  glass and decorative glow. Exact pixels may evolve only through the semantic recipes above.
- **Surface toolbar:** Move Up and Move Down form the left-hand reorder group. Pin is an icon-only
  thumbtack on the right, uses a stable accessible name, exposes pressed state, and provides a text
  tooltip. Non-pinnable daemon-owned Surfaces still omit Pin.
- **Focus and reveal:** there is no user-facing Focus action. Route state identifies the current
  Space and Surface. Programmatic reveal is reserved for explicit system or Agent events such as a
  Surface created by the initiating turn or a Pending decision that must be shown. Direct links may
  select their route. Ordinary Atom and ordering actions must not repurpose this mechanism.
- **Behavior preservation:** this issue does not redefine Gateway-confirmed ordering, Pin
  membership, fast-path delivery, Pending-decision outcomes, Surface presentation, route recovery,
  or Agent authorship. Existing canonical issues remain authoritative for those behaviors.
- **Responsive behavior:** phone and desktop use the same information hierarchy but distinct
  compositions. No control may leave the viewport, overlap content, or become pointer-only at the
  supported narrow and wide reference sizes.
- **Motion:** motion communicates insertion, state change, progress, direct manipulation, or
  event-specific reveal. It is brief, interruptible, localized, and based on shared motion tokens.
  Reduced motion removes movement without removing state indication.
- **Durable governance:** add a repository-open visual-language document defining the material
  boundary, geometry, semantic tokens, typography, density, motion purposes, accessibility
  fallbacks, phone/desktop adaptation, prohibited defaults, and the process for extending the
  system.
- **Reference inventory:** provide deterministic representative data for Home, Space detail,
  Surface chrome, chat, Pending decisions, onboarding, Model connections, and every Atom. Include
  long, empty, loading, stale, updated, error, offline, queued, and reduced-motion states.
- **Change gate:** a future UI change must state the hierarchy or product state it improves, prefer
  a semantic token or shared component, show phone and desktop evidence, cover affected
  accessibility behavior, and demonstrate that established routes and actions are unchanged.
- **Architecture:** no protocol schema, Gateway contract, free-form HTML in Surfaces, or
  Agent-specific component is introduced by this visual direction.

## Testing Decisions

- Use the PWA in a real browser as the highest acceptance seam. Component tests remain the narrow
  seam for accessible roles, names, pressed state, disabled state, DOM order, and event boundaries;
  app routing tests remain the narrow seam for route-derived selection and programmatic reveal.
- Reuse the existing PWA component and routing tests for Surface toolbar behavior, Space selection,
  direct routes, initiating-tab Surface creation, Pending-decision reveal, service-worker
  navigation, and route recovery. Extend those seams rather than introducing a parallel state
  model.
- Add deterministic browser coverage at a narrow phone viewport and a wide desktop viewport. The
  reference sizes must include at least 320 pixels wide and 1440 pixels wide, with dark appearance
  enabled and no horizontal overflow.
- Assert that no visible or assistive-technology-exposed Focus control exists on Surface cards.
  Assert that direct Surface routes still identify the current Surface and that qualifying system
  or Agent events still reveal the intended target.
- Assert that ordinary Atom actions, Move, Pin, and Unpin preserve the current route, selected
  Surface, and keyboard focus except where a separate canonical behavior explicitly requires local
  feedback without navigation.
- Assert exact accessible toolbar order: Move Up, Move Down, then Pin when Pin is available. Verify
  stable Pin naming, pressed state, tooltip text, disabled ordering boundaries, keyboard operation,
  and 44-by-44-pixel coarse-pointer targets.
- Exercise Home, Space detail, Surface content, chat, Pending decisions, onboarding, and Model
  connections with realistic long, empty, loading, stale, updated, error, offline, and queued
  states. Styling-only selectors are not sufficient evidence of behavior.
- Verify keyboard traversal, visible focus, text reflow, control and state contrast, color-independent
  meaning, reduced motion, increased contrast where supported, and opaque fallback behavior.
- Capture reviewable phone and desktop visual evidence from deterministic data. A changed baseline
  must explain which semantic decision changed; regenerating screenshots without that explanation
  is not acceptance.
- Measure material and motion changes in the real browser. Reject broad blur, layout-triggering
  animation, or other effects that produce a material responsiveness regression on the phone path.
- Run the complete repository gate. Browser E2E remains a separate required check for this
  user-facing change and must cover refresh, direct load, reconnect-relevant state, and the key
  interaction paths above.

## Out of Scope

- A Spatial Home redesign, a new visual territory, or three new aesthetic variants.
- A supported light theme during this phase.
- Marketing-site art direction, cinematic scrolling, background video, mascots, or generated Space
  imagery.
- Free-form HTML in Surfaces, per-Space bespoke components, a second design system, or a new Atom
  type solely for styling.
- Adding shadcn, Tailwind, or another component framework as a dependency.
- Changing Space, Surface, Atom, Pending-decision, ordering, fast-path, or Gateway semantics.
- Replacing current Move controls with drag-only interaction or introducing free rearrangement.
- Reopening already accepted Surface motion, routing, or catalog behavior except where the new
  dark-only visual contract requires documentation and test alignment.

## Further Notes

The accepted direction came from comparing three territories—Quiet Depth, Spatial Home, and
Precision Tool—using the same Veduta product model. Precision Tool best matched the mission, but the
successful implementation path was to refine the incumbent product rather than replace its
structure. This issue therefore treats the approved prototype as a behavioral and visual baseline,
not as permission for a wholesale shell rewrite.

Primary inspiration is the operational clarity of Kraken, the separation between product and
promotion in HYPE, Apple's narrow functional use of material, Linear's attention policy for dense
products, and shadcn's accessible component anatomy. These are principles to adapt, not visual
skins to copy. WCAG 2.2 remains the accessibility baseline.

Related issues include #8, #24, #28, #65, #107, and #109–#111. The open ordering issues retain
ownership of group membership, confirmed mutations, and local Pin feedback; this issue owns the
visual contract and prevents those additions from reintroducing a visible Focus action or changing
route semantics.

The approved prototype is on branch
[`prototype/incumbent-ui-polish`](https://github.com/Ic3b3rg/veduta/tree/prototype/incumbent-ui-polish).
Its final prototype commit is
[`e332bd4`](https://github.com/Ic3b3rg/veduta/commit/e332bd4323425ad8018d4ec868ff3ab1e3145d69);
the branch also contains the preceding wordmark and shell-refinement commits. The full repository
check passed with 2,943 tests, type checking, formatting, linting, and production builds, and the
PWA was reviewed at 320-pixel phone and 1440-pixel desktop widths.
