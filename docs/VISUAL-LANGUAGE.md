# Precision Tool visual language

The approved direction in [#157](https://github.com/Ic3b3rg/veduta/issues/157) makes persistent
Space and Surface content the primary reading plane. Chat is the editing tool; Pending decisions
remain visible and reachable. The [approved prototype](https://github.com/Ic3b3rg/veduta/tree/prototype/incumbent-ui-polish)
is design evidence. Routes, Gateway state, Action outcomes and the closed Atom catalog remain
authoritative.

## Material and color

The target appearance is dark only. Durable content uses opaque catalog `surface`, `surfaceMuted`
and `surfaceRaised` colors, thin borders and modest elevation. The cool `accent` identifies actions
and selection; `success`, `warning` and `danger` express outcomes. Pending decisions use the accent,
attention uses warning, and offline status uses muted text with an explicit label. Color never
carries state by itself.

The transient interaction plane may use translucency only when seeing the context beneath it helps
the task. Its opaque fallback is required. Current shared menu and overlay recipes are opaque.
Broad blur, nested glass, glow, decorative gradients and ambient animation are prohibited defaults.

Shared values belong in `packages/catalog/src/design-system.ts`. The generated `--catalog-*`
variables and existing shadcn/Tailwind mapping are the one shared foundation. Shell-only roles
(page composition, navigation placement and Chat docking) remain in PWA styles. Never add styling
fields to Surface data or emit generated HTML/CSS from the Agent.

## Component recipes

`precisionToolCssText()` supplies named recipes under the opt-in `.precision-tool` root. It sets
the catalog dark variables explicitly, including when the operating system prefers light. Apply
the same boundary to portaled content: the reference provides its root through the catalog's
`PortalContainerContext`, so Sheet and Combobox content inherit dark variables and reduced motion.
Legacy production consumers can retain their aliases during
the [#162–#167 migration](https://github.com/Ic3b3rg/veduta/issues/162); the reference and new recipes
are the target contract, not a second supported light design.

| Recipe           | Use                                                                          |
| ---------------- | ---------------------------------------------------------------------------- |
| `recipe-surface` | Opaque durable content, a thin divider and restrained radius.                |
| `recipe-control` | Compact actions; `data-variant="primary"` identifies the main action.        |
| `recipe-input`   | Readable, bounded text-entry geometry with the same focus treatment.         |
| `recipe-menu`    | Opaque navigation or choice groups using existing accessible controls.       |
| `recipe-overlay` | Temporary controls inside the existing focus-managed Sheet.                  |
| `recipe-status`  | Named outcomes with a visible label; `data-tone` chooses the semantic color. |
| `recipe-focus`   | A visible focus outline for keyboard-operable elements.                      |
| `recipe-motion`  | Brief opacity or border feedback for an actual state transition.             |

Use the real shadcn-derived components already in `packages/catalog/src/ui` for direct equivalents.
Composition Atoms use the same tokens. A recipe supplies appearance, never keyboard semantics,
state persistence, mutation authority or permission checks. Keep a control's accessible name stable;
express toggles with pressed/checked state. Icon-only actions need a name and a text tooltip.

## Geometry, typography and density

Use catalog spacing (4, 8, 12, 16, 24 px), radii (4 and 8 px), and the operational font scale
(12, 13, 15, 18, 24 px). Reading text uses the larger body sizes and a comfortable line height;
metadata remains subordinate. Align numerical values with tabular numerals where comparison matters.
Shared controls are 32 px high and retain a 44-by-44 px target on coarse pointers. Visual density
must never shrink touch targets or remove a focus indicator.

The owner-reviewed Chat composition in [#228](https://github.com/Ic3b3rg/veduta/issues/228) has
deliberate shell-only exceptions. Conversation text uses 16 px with a 1.7 line height for long
replies; the composer also uses 16 px to avoid mobile input zoom. Its 14 px vertical inset and
20 px outer spacing separate writing from reading. The composer and model modal use a 12 px
radius; modal fields use 20 px spacing. The model trigger is 36 px high, send/latest controls
are 40 px circles, and the launcher is 48 px. Coarse-pointer controls retain at least 44 px
targets. These choices apply to Chat presentation, not to Surface data or the catalog defaults.

At 320 px, prefer one main reading column and disclose secondary detail. At 1440 px, use width for
parallel context without stretching reading lines or inflating empty cards. Long titles, translated
copy, dates and controls must wrap intentionally. Chat and overlays must not conceal approvals or
focused controls. Routine Atom actions preserve the established route and focus contract.

The production shell gives Home/Space content its own scroll region and keeps Chat in a
persistent right-hand rail from 960 px. Below that width an icon-only, 48 px circular button opens
a full-screen Sheet. Opening focuses its heading for reading; it never opens the keyboard.
Closing restores focus to the launcher and preserves the draft and reading position. Drafts are
separate for each Chat scope. A pending review remains reachable beside the launcher and above
Chat through the same exact Decision Surface link used elsewhere.

A submitted turn anchors its user message near the top so a long incoming reply does not pull the
reader down. The latest-message button resumes following and disappears at the bottom. Gateway
history, retry, queued submissions and decision authority remain unchanged. The topbar model
control opens the existing verify-then-commit Connection and Model fields in a modal.

The mobile composer uses Enter for a new line and the arrow or Ctrl/Cmd+Enter to send. Desktop
retains Enter to send and Shift+Enter for a new line. The viewport opts into
[`interactive-widget=resizes-content`](https://developer.chrome.com/blog/viewport-resize-behavior);
the Sheet also follows the visual viewport while an on-screen keyboard is open. Zoom remains
enabled; browser resize tests do not replace a physical-device keyboard check.

## Motion and accessibility

Motion may explain insertion, an update, progress or a specific reveal. Use the existing catalog
duration/easing tokens and interruptible local feedback; never move unrelated content. Reduced
motion removes movement while retaining text and state indication. All material and state must
remain legible without effects. Check normal text contrast of at least 4.5:1 and meaningful control
and focus contrast of at least 3:1; test keyboard access, focus return and narrow-screen reflow.

## Deterministic contributor inventory

Run `pnpm --filter @veduta/pwa dev` and open `/showcase/reference`. The reference uses real Home,
Space, Surface, Chat, Pending-decision, onboarding and Model-connection components plus the complete
validated Atom catalog. It requires no running daemon or accounts and writes no persistent data.
Its explicit presentation context fixes the clock to `2026-10-09T10:00:00Z` and selects dark.
Sample actions demonstrate local feedback only; reload restores the sample.

Select long, empty, loading, stale, updated, error, offline, queued or reduced-motion state. The
stale example retains expired content with its real notice; updated content changes one region;
queued and interrupted Chat use the actual timeline presentations. Pending skeletons use the fixed
presentation clock. The reduced-motion reference suppresses both CSS and Atom Web Animations.

The browser regression captures the reference at 320 and 1440 px, checks reflow, keyboard focus and
overlay return, exercises the representative states, and rejects application API or external
requests. Component gates compare the fixture's Atom types with the protocol catalog. Recipe gates
reject undeclared catalog-variable references. Do not replace production regions with screenshot
imitations or ideal-only fixtures to make this page look better.

## Contribution gate

For every visual change, name the product state or hierarchy it improves, reuse a token or recipe,
and show phone and desktop evidence. Exercise long and failure states, refresh and relevant recovery
paths. Check keyboard and touch use, contrast, reduced motion and the opaque fallback. Preserve
canonical route and Action behavior. Run the relevant browser suite and `pnpm check`.

Extend a shared recipe when an existing role is insufficient, explain why, and add its reference
example and verification in the same change. A page-specific exception must name its reason and
must not introduce another palette or generated Surface styling.
