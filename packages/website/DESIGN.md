---
name: Veduta website
description: The Precision Tool identity for Veduta's landing and guided tour.
colors:
  paper: '#0f1017'
  ink: '#f4f4f5'
  muted: '#a4a4b0'
  line: '#30313d'
  accent: '#a994ff'
  accent-hover: '#c1b2ff'
  accent-ink: '#0b0911'
  media-ground: '#111214'
  surface-muted: '#191a23'
  surface-raised: '#14151d'
  focus: '#b8a7ff'
typography:
  display:
    fontFamily: 'Inter, sans-serif'
    fontSize: 'clamp(44px, 5.2vw, 76px)'
    fontWeight: 550
    lineHeight: 1.05
    letterSpacing: '-0.035em'
  display-mobile:
    fontFamily: 'Inter, sans-serif'
    fontSize: 'clamp(40px, 8.8vw, 56px)'
    fontWeight: 550
    lineHeight: 1.05
    letterSpacing: '-0.035em'
  headline:
    fontFamily: 'Inter, sans-serif'
    fontSize: 'clamp(30px, 3vw, 42px)'
    fontWeight: 500
    lineHeight: 1.12
    letterSpacing: '-0.035em'
  lead:
    fontFamily: 'Inter, sans-serif'
    fontSize: '18px'
    fontWeight: 400
    lineHeight: 1.65
  body:
    fontFamily: 'Inter, sans-serif'
    fontSize: '16px'
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: 'Inter, sans-serif'
    fontSize: '13px'
    fontWeight: 400
    lineHeight: 1.6
  action:
    fontFamily: 'Inter, sans-serif'
    fontSize: '15px'
    fontWeight: 600
  action-small:
    fontFamily: 'Inter, sans-serif'
    fontSize: '14px'
    fontWeight: 600
rounded:
  catalog-sm: '4px'
  catalog-md: '8px'
  control: '12px'
  media: '16px'
spacing:
  compact: '12px'
  content: '16px'
  group: '24px'
  mobile-gutter: '20px'
  desktop-gutter: '48px'
  section: '104px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.accent-ink}'
    typography: '{typography.action}'
    rounded: '{rounded.control}'
    padding: '12px 22px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
    textColor: '{colors.accent-ink}'
  button-primary-small:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.accent-ink}'
    typography: '{typography.action-small}'
    rounded: '{rounded.control}'
    padding: '10px 18px'
  media-frame:
    backgroundColor: '{colors.media-ground}'
    rounded: '{rounded.media}'
    width: '100%'
  tour-action:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
    padding: '12px 16px'
    width: '100%'
  tour-action-hover:
    backgroundColor: '{colors.paper}'
  tour-space-card:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.ink}'
    rounded: '{rounded.catalog-md}'
    padding: '{spacing.content}'
  tour-chat-field:
    backgroundColor: '{colors.surface-raised}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
  tour-count:
    backgroundColor: 'color-mix(in srgb, var(--catalog-color-surface-muted) 78%, transparent)'
    textColor: '{colors.muted}'
    rounded: '{rounded.catalog-sm}'
    padding: '4px 8px'
---

# Design System: Veduta website

## Overview

**Creative North Star: "Precision Tool"**

The website carries Veduta's established dark tool identity into a readable visitor-facing page.
Opaque surfaces, restrained violet actions and direct Inter typography keep attention on the
actual interface. The guided tour uses production presentation, with a small frame for guidance.

This reference covers `packages/website`. [The visual language](../../docs/VISUAL-LANGUAGE.md)
and [catalog tokens](../catalog/src/design-system.ts) own shared PWA and Atom styling;
[landing CSS](src/landing.css) and [tour CSS](src/demo.css) supply the implemented website
conventions. [PRODUCT.md](PRODUCT.md) owns surface scope. Product and demonstration truth remain
in the [README](../../README.md), [glossary](../../GLOSSARY.md),
[ADR-0036](../../docs/adr/0036-static-public-product-tour.md) and [demo guide](../../docs/DEMO.md).

**Key Characteristics:**

- Dark, opaque material separated by fine borders.
- Generous marketing typography beside the actual product.
- Restrained controls and shared production rendering in the tour.

## Colors

The landing palette directly matches the catalog's dark foundation. Frontmatter records the
website's values; shared tour values continue to come from the catalog.

### Primary

- **Soft violet (`accent`)** marks the primary action, link hover and landing keyboard focus.
  `accent-hover` brightens primary controls; `accent-ink` supplies their dark text.
- **Pale violet (`focus`)** is the shared tour keyboard-focus color.

### Neutral

- **Deep ground (`paper`)** forms the landing background and the tour's content plane.
- **Cool white (`ink`)** carries headings and primary text.
- **Muted lavender gray (`muted`)** carries supporting text, captions and disclosures.
- **Slate hairline (`line`)** separates regions and bounds media or controls.
- **Raised ground (`surface-raised`)** distinguishes the tour's bounded controls and content.
- **Muted ground (`surface-muted`)** supplies the shared tour's compact metadata chips.
- **Media ground (`media-ground`)** sits beneath the video and outside the tour's main frame.

## Typography

Inter is self-hosted as a variable WOFF2 font with `font-display: swap`. The landing uses a sans-serif
fallback; the tour inherits the catalog's system fallback stack.

Display and section headings use the frontmatter hierarchy, balanced wrapping and tight tracking.
The lead introduces the product; body copy stays comfortably spaced with reading limits of
roughly 48–70 characters. Captions and secondary information use the label role. The benefit
headings are compact bold titles (23 px); the final invitation grows to `clamp(36px, 4vw, 58px)`.
The tour retains the catalog's operational scale and the PWA's Chat typography.

## Layout

The landing shares one centered container across header, main and footer, capped at 1280 px with
the desktop gutter on each side. Broad vertical intervals separate sections; the common section
space belongs to the marketing page, not to product controls. Three benefits use equal columns;
the persistence illustration and explanatory copy use an asymmetric pair.

At 1100 px, the introduction's actions move below the lead and column gaps tighten. At 700 px,
the mobile gutter replaces the desktop gutter, navigation wraps to its own row, multi-column
sections stack, `display-mobile` replaces `display` with a 12-character heading limit, and the
lead uses the body size.

The tour is capped at 1500 px with 24 px vertical and 32 px horizontal padding. Its content sits
beside a 380 px guide/Chat column with a 40 px gap. At 1000 px, padding becomes 20 px and the
order becomes guide, content, Chat. Chat remains in the document flow, with bounded scrolling
for its timeline; the guide remains before content on mobile.

## Elevation & Depth

The landing uses no shadows: opacity, fine dividers and media outlines supply separation.
Precision Tool removes lifted and glass treatments from the tour's shared cards and Chat.
The Chat field retains its shared focus ring. Depth and feedback come from the existing component
states rather than decorative effects.

## Shapes

Landing actions and the persistence image use the control radius; the video uses the media radius.
The tour's guide actions use the control radius, while its shared Space cards keep the catalog
radius. Fine single-pixel outlines frame media, cards and guide controls. Benefit copy sits directly
on the page without card wrappers.

## Components

- **Primary actions:** violet filled links, a 48 px minimum height, semibold text and a brighter
  hover. The header variant has a 44 px minimum height. Landing focus is a 2 px outline with a
  5 px offset. The background transition lasts 160 ms with ease-out.
- **Text links and navigation:** text remains the foreground color until violet hover; inline
  links retain underlines. Navigation and action links have at least 44 px targets. The wordmark
  pairs the transparent Veduta mark at 40 px with Inter text and a small muted alpha/license
  annotation. Product images scale with their containers; brand marks retain explicit dimensions.
  The PWA and guided demo use the same symbol at 32 px.
- **Product media:** the real PWA video and images span their container and keep their aspect
  ratio. Captions remain subordinate and readable; native video controls and the transcript
  disclosure provide access to the demonstration.
- **Tour guidance:** the next-step button is full width, left aligned and raised against the
  content ground, with a darker hover. Reset uses the same bounded material. Tour links and
  buttons receive a 2 px focus outline with a 4 px offset.
- **Tour content and Chat:** `HomeSpaceGrid`, `SpaceSection`, `ChatBar` and `PresentationContext`
  supply the real Home, Space, Atom and Chat presentation. The website changes their placement;
  shared controls, cards and fields retain their production styling. Read the
  [visual language](../../docs/VISUAL-LANGUAGE.md) before changing them.

Reduced motion removes landing smooth scrolling and button transitions. Shared tour components
retain their existing reduced-motion behavior.

## Do's and Don'ts

### Do:

- **Do** use the catalog's dark identity and the implemented website CSS as visual authority.
- **Do** keep product imagery clear, proportional and accompanied by readable captions.
- **Do** preserve the mobile guide-first order, wrapping and visible keyboard focus.

### Don't:

- **Don't** replace shared tour components with independent visual replicas.
- **Don't** introduce decorative gradients, glow, glass or ambient animation into this identity.
- **Don't** apply the landing's marketing type and spacing scale to production Atom controls.
