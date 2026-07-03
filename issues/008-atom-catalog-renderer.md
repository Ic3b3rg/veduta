# 008 — Atom catalog + PWA renderer + design system

## Context

Visual consistency is THE differentiator ([PRD §2](../PRD.md)): we control the design system, the Agent brings the data.

## Goal

The `catalog` package: the renderer for all v1 Atoms with a curated design system.

## Tasks

- Renderer for the ~28 Atoms ([issue 002](002-surface-protocol.md)) — reactive binding to state, fast/agent action dispatch
- Design system: tokens (spacing, typography, light/dark colors, motion), components that look like a product, not generated output. Before designing: `frontend-design` + `dataviz` skills (for Chart/Stat/Progress)
- Storybook (or equivalent) with every Atom in every state: it is the showcase for contributors
- Accessibility: focus, keyboard, contrast, tap targets (`a11y-debugging` skill for the audit)
- `Automation`: the Atom that shows a job/timer with an on/off toggle (the "UI plus")

## Acceptance criteria

- A Surface composed by the Agent with 10+ Atoms renders consistently in light and dark without ad hoc CSS
- Every action declared `fast` responds visually < 100ms (optimistic update)
- Clean a11y audit on the interactive Atoms

## Dependencies

002 (parallel to 007)
