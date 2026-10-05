# Connections navigation and bundle verification

Work: [#202](https://github.com/Ic3b3rg/veduta/issues/202), a refinement of
[#181](https://github.com/Ic3b3rg/veduta/issues/181).

The Connections page follows the existing catalog-owned shadcn tokens and the
[Sidebar composition pattern](https://ui.shadcn.com/docs/components/radix/sidebar): header,
scrollable navigation, active menu item and footer. It uses only the static composition needed by
this page, with Lucide icons, named links, visible keyboard focus and 44px minimum touch targets.
Accounts & services, Models, Extensions, Space access and Back to Veduta remain available. Below
880px the navigation uses two columns, so every section remains visible without horizontal scrolling.

## Bundle measurements

Production builds on 2026-10-05 used the same installed dependencies and
`pnpm --filter @veduta/pwa build`. Sizes are decimal kB reported by Vite, before compression unless
the gzip column is specified.

| Asset                           |   Before |    After | Before gzip | After gzip |
| ------------------------------- | -------: | -------: | ----------: | ---------: |
| Initial JavaScript              | 1,203.26 | 1,122.06 |      368.46 |     346.34 |
| Initial CSS                     |    92.82 |    86.89 |       15.45 |      14.18 |
| Deferred Connections JavaScript |        0 |    85.88 |           0 |      25.30 |
| Deferred Connections CSS        |        0 |     6.56 |           0 |       1.65 |

The main improvement is deferred route loading: Connections downloads when that route is opened.
Its loading state preserves routing inputs, and a failed import offers reload and a working Home
link. Home, Chat, offline Surface rendering and the complete Atom catalog remain in the initial
bundle. Total JavaScript grows slightly for the navigation and recovery UI; initial transfer drops
by 81.20 kB, or 22.12 kB compressed. The existing large-chunk warning remains visible.

Declaring the protocol package's pure exports with `sideEffects: false` independently removed
2.06 kB of unused schema initialization (0.47 kB gzip). Protocol source modules perform no
registration, I/O, global mutation or bare side-effect imports. Used validators remain required
imports and still execute. A matching catalog-package experiment was reverted because it did not
produce an additional useful reduction; no broad dependency deletion or Atom removal was retained.

## Runtime proof and repeatable UI checks

A disposable Gateway served the production PWA build. Visible browser inspection covered 320,
768, 1024 and 1440px viewports: all four sections remained reachable, the current link matched the
displayed section and no page overflow occurred. Keyboard navigation showed the focus ring;
Escape closed Add account and returned focus to its opener, and keyboard activation of Back to
Veduta returned to Home. The provider setup fixtures used no real credentials.

1. From Home, open Connections. Visit each sidebar section and confirm the active item and heading.
2. Refresh Models, then use browser Back and Forward. Confirm route and section remain consistent.
3. Open Add account, switch among Gmail, GitHub and Other email, and close with Escape. Focus must
   return to Add account. Review an account and exercise a provider error inside the same modal.
4. Repeat at narrow widths. All section links and Back to Veduta must remain available; the account
   modal fills the viewport and its footer stays reachable.
5. Return to Home and open existing Surfaces. Chat, charts, forms and fast-path controls remain
   available. Normal offline cached-Home behavior remains unchanged.

The existing routing/Home and account setup suites cover the same features. Dedicated route tests
cover deferred loading, preservation of the Models entry point and recovery from chunk failure.
The authenticated Local VPS journeys retain setup denial, redaction, another authenticated browser,
reload/restart, cancellation and Chat continuation-link assertions under the updated modal flow.
