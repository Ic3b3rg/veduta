# 024 — Derive PWA shell CSS variables from catalog tokens

## Context

Follow-up noted while closing [issue 008](008-atom-catalog-renderer.md): the PWA shell's palette in
its stylesheet hand-mirrors the catalog design-system tokens (`catalogTokens`), creating a second
source of truth. The two have already drifted in light mode (shell text `#17202a` vs catalog
`#18202b`, shell border `#d9e0e8` vs catalog `#d8dee8`), and nothing catches future drift: any
catalog token change would leave shell chrome subtly mismatched with Atom content.

## Goal

One source of truth for the colors shared between the catalog design system and the PWA shell, in
both light and dark, with drift caught by a test instead of by eye.

## Tasks

- The catalog exposes a CSS-custom-properties representation of its themes, derived from
  `catalogTokens` (both light and dark)
- The PWA applies it at the document root and drops every hand-coded hex value that duplicates a
  catalog token; the current light-mode drift disappears
- Shell-only tokens (status pills, chat dock, success/warning/danger surface triads) stay
  hand-authored in the shell stylesheet, clearly separated from the derived set
- A test fails when the shared variables and `catalogTokens` diverge for either theme

## Acceptance criteria

- Every color shared by shell chrome and Atoms is defined once, in the catalog design system
- Shell chrome uses exact catalog token values in light and dark, verified in a real browser with
  no visual regression
- A drift between shell shared variables and `catalogTokens` fails the test suite

## Dependencies

008
