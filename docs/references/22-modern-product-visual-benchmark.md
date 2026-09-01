# Research 22 — Modern product visual benchmark for Veduta

> Conducted and accessed on 2026-08-28 from first-party product surfaces, official documentation,
> and platform specifications. Visual observations describe the
> live surface inspected, not a permanent property of the brand. Recommendations marked
> **Inference** are conclusions for Veduta, not claims made by the sources. This report selects no
> direction and creates no prototype, specification, or ticket.

## Result

The benchmark supports three genuinely different prototype territories:

1. **Quiet Depth** — calm, tactile, and state-led; depth is reserved for controls above solid
   content.
2. **Spatial Home** — expressive, environmental, and editorial; each Space feels like a place.
3. **Precision Tool** — compact, operational, and information-dense; the product's real objects
   create the visual character.

They must use the same representative Veduta data and flows on both phone and desktop. Otherwise,
content selection will be confused with visual quality. None is a recommendation yet.

## First-party benchmark

| Source and surface                                                                                                                                                                                                                                                                                                                                           | Observable visual/product traits                                                                                                                                                                                                                                                                                             | Transferable to Veduta                                                                                                                                                                         | Spectacle boundary and constraints                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Apple Human Interface Guidelines: Materials](https://developer.apple.com/design/human-interface-guidelines/materials), [Adopting Liquid Glass](https://developer.apple.com/documentation/technologyoverviews/adopting-liquid-glass), [Motion](https://developer.apple.com/design/human-interface-guidelines/motion) — platform system, not a marketing page | Liquid Glass occupies the top functional layer for navigation and controls; content remains visually distinct. Motion follows input, communicates continuity, stays brief, and remains interruptible.                                                                                                                        | A selective interaction material for chat, navigation, menus, and Pending-decision controls; solid Surface content beneath it; depth that communicates layer and action.                       | Universal glass would reverse Apple's hierarchy. Translucency needs an opaque/high-contrast alternative, and frequent actions must not wait for motion. A web implementation cannot assume Apple's native refraction or adaptive contrast.                                        |
| [HYPE homepage](https://www.hype.it/) — marketing; [HYPE App Store listing](https://apps.apple.com/it/app/hype-carta-conto-e-app/id943405905) — developer-published operational screenshots                                                                                                                                                                  | The live site used a warm near-white ground, black and white fields, electric blue accents, Gordita typography, large uppercase chapters, and scenario-led storytelling. The app publication foregrounds balances, payments, savings, and controls rather than the marketing atmosphere.                                     | Separate brand atmosphere from operational clarity; lead with recognizable life jobs; allow one strong brand moment around a precise everyday interface.                                       | Oversized all-caps copy and image-led chapters are promotional devices, not a Surface grammar. Large media costs bandwidth; compact phone controls and financial states need independent contrast, target-size, and error review. The listing is evidence for phone, not desktop. |
| [Kraken Pro](https://pro.kraken.com/) — product marketing; [trading-interface guide](https://support.kraken.com/articles/kraken-pro-trading-interface-guide), [layout guide](https://support.kraken.com/articles/setting-up-a-versatile-layout-on-kraken-pro) — operational documentation                                                                    | Dark segmented work areas, live data, charts, order controls, compact labels, saved layouts, and 25+ rearrangeable widgets. Product capability, not decoration, supplies most of the identity.                                                                                                                               | Let Spaces, Surfaces, freshness, attention, and Pending decisions dominate. Use alignment, density, and direct manipulation to create confidence on desktop.                                   | A trading cockpit copied literally would make a personal Agent cold and intimidating. Tiny labels, red/green dependence, drag-only layout, and continuously updating charts require keyboard, contrast, reduced-motion, and rendering checks.                                     |
| [Hyperliquid trade](https://app.hyperliquid.xyz/trade) — public operational product                                                                                                                                                                                                                                                                          | The inspected desktop used near-black teal panels, 12px secondary labels, a restrained mint accent, small 4–8px radii, live market figures, chart, order book, and order form in one tight grid. There was almost no decorative card styling.                                                                                | Evidence that a contemporary crypto product can feel distinctive through a strict palette, compact geometry, and live state rather than gradients or glass.                                    | Its density assumes expert intent and a large screen. Veduta cannot reduce descriptive text to trading-terminal sizes or encode status in mint/pink alone. Phone must reprioritize and sequence panels, not shrink this grid.                                                     |
| [Jupiter](https://jup.ag/) — operational Home; [product documentation](https://docs.jup.ag/)                                                                                                                                                                                                                                                                 | Product and discovery coexist: a persistent sidebar, global search, portfolio context, a focused transaction panel, market modules, and clear Trade/Earn/Manage groupings. The inspected UI used a very dark neutral canvas, muted blue-gray text, an acid-lime action accent, Inter, and compact 12–14px navigation.        | A useful model for Home as the product itself: stable navigation plus one primary operation and secondary living modules. Group capabilities by user job, not implementation type.             | Its many pills, promotions, token imagery, and modules can become a generic crypto portal. Veduta must not turn Home into an indiscriminate feed. Live data and remote imagery also create loading, distraction, and network-cost risks.                                          |
| [Polymarket](https://polymarket.com/) — public operational Home                                                                                                                                                                                                                                                                                              | The public surface exposes categories, search and filters, featured and live markets, probabilities, volume, deadlines, and immediate outcome actions. High information density is organized around one repeated domain object.                                                                                              | Repeat a strong, recognizable Surface summary grammar; make state and next action scannable without opening every Space.                                                                       | Repetition works because every object is a market. Veduta's Surfaces are heterogeneous, so forcing them into one identical card would erase meaning. Live tickers, news, comments, and odds would also be noise in a home-first personal product.                                 |
| [Linear: A calmer interface for a product in motion](https://linear.app/now/behind-the-latest-design-refresh), [Design for the AI age](https://linear.app/now/design-for-the-ai-age), [A Linear spin on Liquid Glass](https://linear.app/now/linear-liquid-glass) — first-party product rationale                                                            | The 2026 refresh dims navigation, removes excess icon treatments and separators, warms neutral colors, and preserves dense work content. Linear treats AI as a tool on a structured workbench. Its mobile glass omits refraction because it harms dense-interface legibility and adds explicit increased-contrast treatment. | Strong evidence for Home and Surfaces as the durable workbench, with chat layered onto it; structure should recede after orientation; semantic hierarchy should survive future feature growth. | Copying Linear's low-chroma gray shell would produce another Linear imitation. Its value is the attention policy and systematic stress-testing across views, not its exact palette or chrome.                                                                                     |
| [Monad](https://www.monad.xyz/) — protocol marketing                                                                                                                                                                                                                                                                                                         | A stark white/black editorial composition uses a purple accent, custom display type, mono labels, large negative space, long vertical chapters, a video, and graphic network imagery. Type and pacing create identity more than card decoration.                                                                             | Use a distinctive type pairing, asymmetric rhythm, and one accent to make Veduta recognizable without adding visual effects to every Surface.                                                  | A long cinematic scroll, huge claims, and sparse hero sections communicate a protocol narrative, not recurring work. Video and graphic layers need reduced-motion/data alternatives and must stay outside frequent interaction paths.                                             |
| [MegaETH](https://www.megaeth.com/) — protocol marketing                                                                                                                                                                                                                                                                                                     | The inspected surface used a warm gray ground, near-black type, oversized uppercase Helvetica, a bespoke mono face, square geometry, full-width video/canvas scenes, and a horizontal editorial news rail. It rejects the familiar rounded-gradient crypto template.                                                         | A strong reference for **Spatial Home**: industrial typography, hard-edged layout, large-scale transitions, and spatial sequencing can create depth without glass or bento cards.              | Three videos and a canvas were present in the inspected page. That media load and horizontal choreography are inappropriate as a default application shell; they require progressive enhancement, static fallbacks, and aggressive mobile simplification.                         |
| [Abstract](https://abs.xyz/) — ecosystem marketing                                                                                                                                                                                                                                                                                                           | The page combines playful character imagery, stretched letter spacing, ecosystem spotlights, product categories, and a portal metaphor aimed at consumer crypto rather than finance professionals.                                                                                                                           | A Space can gain warmth and recognizability through authored illustration, shape, or an environmental motif, while its Surface content remains structured.                                     | Mascots, floating assets, and ecosystem-card abundance can quickly become decorative noise or synthetic personality. Identity must be stable and authored, never generated per Surface, and imagery needs text alternatives and a low-cost mobile path.                           |

## Territory 1 — Quiet Depth

**Plain-language thesis:** Veduta feels calm and private; the content is solid and readable, while
only the controls that genuinely float above it gain translucency and elevation.

- **Palette:** warm bone, ink, graphite, one mineral green or blue state accent, amber only for
  attention. Light and dark are the same identity, not unrelated color schemes.
- **Materials:** opaque Surfaces; thin separators and tonal elevation; selective translucent chat,
  navigation, menus, and transient decision controls with an opaque fallback.
- **Typography:** humanist sans for reading, restrained mono for timestamps, provenance, and live
  state. Sentence case by default.
- **Layout:** generous but not sparse; one clear reading plane; minimal nested containers.
- **Motion:** short focus transfer, localized Surface-update feedback, and direct-manipulation
  continuity. No ambient drift.
- **Signature:** a quiet “living edge” that identifies exactly what changed or needs attention.
- **Phone:** bottom interaction layer, single-column Surface sequence, thumb-reachable primary
  actions. **Desktop:** more simultaneous context, but the same content/interaction boundary.
- **Risk:** becoming tasteful but generic. It needs a recognizably Veduta state language, not merely
  beige colors and blur.

## Territory 2 — Spatial Home

**Plain-language thesis:** Home is not a grid of interchangeable cards. Spaces feel like stable
places, using scale, typography, occlusion, and transitions to create an environment.

- **Palette:** a stable neutral base with one saturated field color; optional deterministic Space
  accents only if the product decision is explicit.
- **Materials:** broad color or texture fields, hard-edged content planes, occasional foreground
  sheets; little or no conventional glass-card treatment.
- **Typography:** expressive display face paired with a highly legible text face and mono state
  labels.
- **Layout:** asymmetric editorial composition; Space summaries form a spatial map rather than a
  uniform bento grid.
- **Motion:** entering a Space preserves spatial continuity; restrained scale/occlusion transitions;
  content updates remain local and immediate.
- **Signature:** each Space has a memorable position and atmosphere while every Surface keeps the
  shared Atom language.
- **Phone:** vertical chapters and snap-free scrolling, with heavy scenes replaced by static
  compositions. **Desktop:** wider spatial relationships and deliberate negative space.
- **Risk:** drifting into a crypto marketing site. The prototype must prove repeat visits, long
  content, errors, and fast-path actions—not only a hero state.

## Territory 3 — Precision Tool

**Plain-language thesis:** Veduta feels like a serious instrument. Dense information, alignment,
and state transitions carry the design; ornament almost disappears.

- **Palette:** near-black or warm white, layered neutral panels, one cool operational accent, and
  separate semantic attention/error colors.
- **Materials:** opaque panels, low radii, crisp dividers, no glow; elevation only for temporary
  controls.
- **Typography:** compact grotesk or sans, tabular numerals, mono metadata; a disciplined 12–16px
  operational scale with larger reading text inside Surfaces.
- **Layout:** stable rails and headers; high-density Space and Surface summaries; predictable action
  locations; optional user-controlled density rather than free rearrangement.
- **Motion:** almost none beyond insertion, state change, progress, and focus continuity.
- **Signature:** visible operational truth—freshness, provenance, Agent activity, and Pending
  decisions—presented with exceptional precision.
- **Phone:** prioritize one job at a time and progressively disclose metadata. **Desktop:** use width
  for parallel context, not larger empty cards.
- **Risk:** feeling impersonal or like a trading terminal. Personal language, readable Surface
  content, and warm details must counterbalance the shell.

## How to derive the second round without producing cosmetic duplicates

After one territory is accepted, keep its thesis, representative data, information hierarchy, and
complete phone/desktop flows fixed. Produce three vertical variants that each push one dimension:

1. **Material variant:** tests the territory's depth, surface, and color budget.
2. **Typography/density variant:** tests reading rhythm, information compression, and scale.
3. **Motion/navigation variant:** tests how Home, a Space, a Surface update, a Pending decision, and
   chat connect over time.

Changing all three dimensions again would recreate three unrelated directions and make feedback
non-diagnostic.

## Shared acceptance constraints

All territories must remain recognizable with gradients, blur, and decorative imagery disabled.
They must exercise long, empty, loading, stale, error, updated, and Pending states with realistic
Veduta data. Both phone and desktop are first-class; neither is a scaled version of the other.

WCAG 2.2 requires 4.5:1 contrast for ordinary text, 3:1 for large text, and 3:1 for visual
information needed to identify controls and states. It also requires content to reflow and focus not
to be obscured. ([WCAG 2.2](https://www.w3.org/TR/WCAG22/)) The current Media Queries Level 5 draft
defines preferences for reduced motion, transparency, data, and increased contrast; these are useful
progressive enhancements, not substitutes for robust defaults.
([Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/))

**Inference:** the durable visual-language document created after prototype acceptance should record
semantic material roles, typography and density rules, motion purposes, accessibility fallbacks,
phone/desktop adaptation, and examples of prohibited misuse. It should preserve intent while
allowing future UI changes; it should not freeze the accepted prototype pixel-for-pixel.
