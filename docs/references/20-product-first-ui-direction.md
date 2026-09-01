# Research 20 — A product-first visual direction beyond “AI slop”

> Conducted on 2026-08-28 from primary and first-party sources. Product pages were inspected as
> they appeared on that date. Statements marked **Inference** are recommendations for Veduta drawn
> from the cited evidence; they are not claims made by the sources. This report proposes neither a
> prototype nor an implementation ticket.

## Executive finding

Veduta does not need more visual effects. It needs a stronger visual explanation of its product:
durable living state in Spaces and Surfaces, with chat as the editing tool. The most defensible
direction is **quiet depth, vivid state**:

- keep the content plane calm, opaque, information-dense, and easy to scan;
- reserve translucency for a small interaction plane — navigation, the chat dock, menus, and
  transient overlays — where seeing context beneath it has functional value;
- create depth chiefly with scale, alignment, occlusion, tonal contrast, and selective elevation,
  not by blurring every card;
- use color and motion to explain priority, state change, provenance, and direct manipulation;
- retain a stable spatial model so the Agent can change data and compose Atoms without making the
  product feel newly generated on every visit.

This is not “make Veduta look like Apple, HYPE, or Kraken.” Their transferable lesson is that the
visual language serves a specific operating model. Apple separates controls from content, HYPE
leads with everyday financial jobs, and Kraken lets dense, customizable data remain the hero.

## What the “AI slop” diagnosis can and cannot claim

### Evidence

The March 13, 2026 paper _Interrogating Design Homogenization in Web Vibe Coding_ characterizes the
vibe-coding lifecycle, reviews 63 academic and gray-literature sources, and performs a
sociotechnical risk analysis. It identifies frictionless generation and the cost of refactoring
generated output as forces that can encourage people to accept dominant defaults. The paper does
**not** run a controlled visual comparison of production websites, so it supports “homogenization
is a credible design risk,” not “all AI-built interfaces look the same.”
([Shin et al., 2026](https://arxiv.org/abs/2603.13036))

Google's Material team began its Material 3 Expressive program after internal research raised the
problem that its apps felt similar and boring. Across 46 studies, hundreds of designs, and more
than 18,000 participants, Google reports that purposeful use of color, size, shape, motion, and
containment improved preference and helped participants find key interface elements as much as four
times faster. It also reports the opposite boundary: unfamiliar layouts and missing labels hurt
usability even when a concept looked modern. Context matters, particularly for consequential
products such as banking.
([Google Material research, May 21, 2025](https://design.google/library/expressive-material-design-google-research?pubDate=20250521))

Google's first-party account of designing the AI-powered Clips camera is an older but unusually
relevant product lesson. The team found that an AI product did not need a futuristic interaction
model; it reduced complexity, restored familiar controls, and recommends testing prototypes with a
user's real content rather than polished fake content. Google's guidance for predictive products
also warns that continually rearranging an interface prevents habituation; it recommends putting
dynamic prediction in a stable, dedicated region and designing correction from failure as the
baseline.
([The UX of AI](https://design.google/library/ux-ai),
[Predictably Smart](https://design.google/library/predictably-smart))

### Inference for Veduta

**AI slop is better defined as unearned visual decisions than as a list of forbidden CSS
properties.** A rounded card, gradient, or sans-serif typeface is not intrinsically bad. The slop
signal appears when every element receives the same treatment, decoration does not encode product
meaning, and the screen could belong to any AI dashboard after replacing the logo.

Veduta's current shell already uses a coherent token system and supports reduced motion and reduced
transparency. It also applies shared translucent materials, a 24px blur, glow backgrounds, rounded
cards, inset highlights, and elevated shadows across several content and shell regions.
([foundation styles](../../packages/pwa/src/styles/foundation.css),
[Home styles](../../packages/pwa/src/styles/home.css),
[shell styles](../../packages/pwa/src/styles/shell.css))

That makes “add more glass” the wrong default hypothesis. The prototype should test whether
**subtracting glass from content** and making hierarchy more product-specific yields a stronger
identity.

## What to learn from the named references

### Apple: glass is a functional layer, not a universal skin

Apple introduced Liquid Glass at WWDC25 on June 9, 2025. Its Human Interface Guidelines define it
as a distinct layer for controls and navigation above content. The guidance explicitly says not to
use Liquid Glass in the content layer, to use it sparingly on custom controls, and to reserve its
clearer variant for visually rich backgrounds. The material adapts when people enable Reduce
Transparency or Increase Contrast. Apple updated this guidance on September 9, 2025.
([HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials),
[_Meet Liquid Glass_, WWDC25](https://developer.apple.com/videos/play/wwdc2025/219/))

Apple's broader system guidance says layout and grouping should carry hierarchy, controls should
be visually distinct from content, and motion should be purposeful, brief, optional, and
cancellable. Its accessibility guidance specifically advises against animating depth changes or
blur when reduced motion is requested.
([HIG Layout](https://developer.apple.com/design/human-interface-guidelines/layout),
[HIG Motion, updated September 9, 2025](https://developer.apple.com/design/human-interface-guidelines/motion),
[HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility))

**Inference:** Apple is evidence for one floating Veduta interaction layer, not for translucent
Space and Surface cards. A sticky chat dock, a contextual toolbar, or a transient Pending decision
can use translucency to preserve context. Durable Surface content should normally be opaque.

### HYPE: promote with atmosphere, operate with clarity

HYPE's first-party site organizes the offer around recognizable jobs and situations — payments,
travel, shared expenses, saving, security, and account choice — rather than around design-system
components. Its current App Store screenshots place promotional gradients and dimensional device
renders around an actual app UI that is predominantly opaque, light, and organized around balance,
transactions, card controls, and one clear task at a time. The App Store listed version 7.81.0 on
August 10, 2026 when inspected.
([HYPE homepage, accessed August 28, 2026](https://www.hype.it/),
[HYPE App Store listing, accessed August 28, 2026](https://apps.apple.com/it/app/hype-carta-conto-e-app/id943405905),
[HYPE savings](https://www.hype.it/privati/box-risparmi))

**Inference:** borrow the separation between atmosphere and operation. Veduta can have a
recognizable environmental background or a few strong brand moments, while the state a person must
read and act on stays crisp. Also borrow outcome-first language: a Space should feel like a place
where a life concern is operated, not a generic dashboard tile.

### Kraken: product capability creates the visual character

Kraken Pro's first-party product page presents a dense dark interface of clearly segmented,
mostly opaque panels. Its differentiation is operational: more than 25 trading and data widgets,
saved dashboards, real-time data, direct chart manipulation, and the ability to rearrange and resize
the workspace. Kraken's setup guide, last updated March 31, 2025, documents these actions step by
step. Purple glow is prominent in marketing imagery, but the product UI earns its identity through
data density and control.
([Kraken Pro, accessed August 28, 2026](https://pro.kraken.com/),
[versatile-layout guide](https://support.kraken.com/au/articles/setting-up-a-versatile-layout-on-kraken-pro))

**Inference:** do not copy the crypto palette or dramatic glow. Copy the principle that a tool's
real objects and operations should dominate its visual language. For Veduta those objects are
Spaces, living Surfaces, freshness, attention, Pending decisions, and state changes — not an
ever-present “AI” aesthetic.

### Microsoft Fluent: an independent check on transparency

Microsoft's Acrylic guidance reaches almost the same boundary as Apple independently: use acrylic
for transient or supporting UI, avoid multiple adjacent/layered acrylic surfaces, and prefer opaque
backgrounds for persistent panes that divide content. It also states that acrylic rendering is
GPU-intensive, can increase power consumption, and falls back to a solid color in high contrast,
battery saver, transparency-off, and low-end-hardware contexts. The page was updated July 22, 2026.
([Microsoft Acrylic guidance](https://learn.microsoft.com/en-us/windows/apps/design/style/acrylic))

**Inference:** a grid or feed of blurred Surfaces is both a visual-hierarchy risk and an avoidable
rendering cost. Glass should be a budgeted capability with an opaque equivalent, not the default
material token for every container.

## Recommended visual principles for a prototype

### 1. Two planes, with one job each

| Plane       | Role                                                      | Default material                                    | Likely Veduta examples                                           |
| ----------- | --------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| Content     | Durable state people read and operate                     | Opaque, low-elevation, high-contrast                | Space summaries, Surfaces, Atoms, histories, settings            |
| Interaction | Controls that float over or temporarily interrupt content | Selective translucent material with opaque fallback | Chat dock, menus, sticky navigation, transient decision controls |

Do not nest translucent content cards inside translucent panels. Do not use blur merely to signal
that a card is “premium.” Depth must communicate which layer can be acted on and which state is
behind it.

### 2. Make living state the signature

The prototype should derive its distinctiveness from Veduta's semantics:

- freshness is visible but quiet until stale;
- attention and Pending decisions have an unmistakable, consistent priority treatment;
- a fast-path mutation gives immediate localized feedback;
- Agent-authored changes reveal exactly which region changed without replaying the entire Surface;
- pinned and focused Surfaces gain hierarchy through stable placement and restrained elevation;
- chat remains always available but does not visually outrank the Home.

This builds on the existing motion contract, which already scopes entrance and update feedback to
Atoms and honors reduced motion.
([catalog motion](../../packages/catalog/src/atom-motion.ts),
[Surface motion](../../packages/pwa/src/surface-motion.ts),
[Surface architecture](../../ARCHITECTURE.md#34-surface-engine))

### 3. Expressiveness must improve task hierarchy

Use one or two high-character decisions at a time — for example a distinctive typography pairing,
a recognisable Veduta accent, or an asymmetric composition — while keeping familiar controls and
labels. Scale, shape, color, and containment should answer “what matters now?” This follows the
Material research; ornament that does not improve that answer is removable.

Do not automatically give every Space a generated gradient, icon, and color. If Space-level visual
identity is desirable, whether it is user-chosen, deterministic, or Agent-proposed is a product
decision that the prototype must expose rather than silently settle.

### 4. Motion is evidence, not ambience

Motion is justified for state continuity, direct manipulation, progress, and focus transfer. Avoid
ambient floating, parallax, repeated shimmer after loading, animated background gradients, and
blur/depth animation. Frequent interactions should remain immediate; transitions must never delay
the next action.

On the web, prefer compositor-friendly `transform` and `opacity` and verify smoothness rather than
assuming it. Google warns that animations that trigger layout or paint are expensive, and that
`backdrop-filter` can harm performance.
([web.dev animation performance](https://web.dev/articles/animations-and-performance),
[web.dev backdrop-filter guidance](https://web.dev/articles/backdrop-filter))

### 5. Accessibility is part of the material definition

WCAG 2.2 requires at least 4.5:1 contrast for ordinary text, 3:1 for large text, and 3:1 for the
visual information needed to identify UI components and states. On a translucent surface, those
ratios must hold against the least favorable allowed backdrop, not just the design-tool sample.
([WCAG 2.2, W3C Recommendation December 12, 2024](https://www.w3.org/TR/WCAG22/),
[non-text contrast guidance](https://www.w3.org/WAI/WCAG22/understanding/non-text-contrast.html))

The February 19, 2026 Media Queries Level 5 Working Draft defines both
`prefers-reduced-transparency` and `prefers-reduced-motion`. The former is still a draft feature,
so it is useful progressive enhancement rather than the only fallback path.
([Media Queries Level 5](https://www.w3.org/TR/mediaqueries-5/))

The prototype should therefore include:

- an opaque base that remains fully usable without `backdrop-filter`;
- explicit reduced-transparency and increased-contrast treatments;
- a reduced-motion path that removes nonessential movement, animated depth, and blur;
- keyboard-visible focus, sufficiently delineated controls, and no meaning carried by color alone;
- light and dark modes tested with real, long, empty, stale, error, and Pending content.

## What the prototype should answer

The prototype is valuable only if it resolves decisions that a static moodboard cannot. Use the
same representative Veduta data in each candidate so aesthetic novelty cannot hide information
loss.

1. **Material boundary:** Does opaque Surface content plus a selective glass interaction layer feel
   more distinctive and trustworthy than the current broad glass treatment?
2. **First glance:** Can a person identify the current Space, what changed, and what needs attention
   without first decoding card furniture?
3. **Stable versus living:** Can the composition remain familiar while state visibly changes under
   fast-path and Agent updates?
4. **Density:** How much real Surface information belongs on Home under the accepted metadata-summary
   architecture? If the preferred design needs live content previews, that is an explicit product
   and architecture decision, not a styling detail.
5. **Brand character:** Which few choices make the interface recognizably Veduta when logos and
   copy are hidden?
6. **Adaptation:** Does the direction still work on a small phone, wide desktop, dark mode, reduced
   motion, reduced transparency, and a lower-powered device?

Acceptance should cover complete flows — opening Home, entering a Space, reading and operating a
Surface, seeing a state patch, resolving a Pending decision, and using chat — rather than approving
one idealized hero screen. Real seed data is essential; Google explicitly reports that polished
fake content can distort AI-product usability testing.

## Guardrails for future UI changes

The visual direction will evolve. Preserve intent without freezing today's pixels:

1. Record durable principles and prohibited uses: the two-plane model, semantic purpose of depth,
   glass budget, motion rules, and accessibility fallbacks.
2. Name tokens by role (`content-surface`, `interaction-material`, `focus-elevation`,
   `state-attention`) rather than by appearance (`glass-card`, `purple-glow`). The first stable
   Design Tokens Community Group format, published October 28, 2025, exists to exchange these
   decisions across tools; it is a stable Community Group report, not a W3C Recommendation, so
   adopting its JSON format is optional.
   ([DTCG 2025.10](https://www.w3.org/community/reports/design-tokens/CG-FINAL-format-20251028/))
3. Keep one reference inventory that exercises every shell state and every Atom with realistic
   light/dark, density, loading, error, and accessibility variants.
4. Make visual changes through semantic tokens and catalog components before adding page-specific
   overrides. Veduta already has a shared catalog token boundary; deepen it rather than create a
   parallel styling system.
   ([catalog design system](../../packages/catalog/src/design-system.ts))
5. Require visual-regression evidence, automated contrast/accessibility checks, and measured
   runtime performance on representative mobile and desktop hardware for material or motion
   changes.
6. Treat a proposed change to information hierarchy, Home content, Agent behavior, or Surface
   semantics as a product decision. A visual refresh must not quietly rewrite the accepted
   home-first or closed-Atom architecture.

## Bottom line

The strongest prototype hypothesis is not “more glass.” It is **a calmer, more legible content
system with one deliberate floating interaction layer, where Veduta's living state supplies the
personality**. HYPE and Kraken show that bold atmosphere can coexist with operational clarity;
Apple and Microsoft show that transparency needs a narrow semantic role; Google shows that
expressiveness works when it directs attention without breaking familiar interaction.

If that hypothesis fails with representative Veduta data, the prototype will have answered a real
question. If it succeeds, the eventual implementation ticket can encode the material boundary,
semantic tokens, full-state fixture, accessibility variants, performance budget, and runtime QA as
long-lived constraints rather than a one-off reskin.
