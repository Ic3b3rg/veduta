# Surfaces = a tree of declarative Atoms from a closed catalog, never free-form HTML

A Surface is a declarative tree of **Atoms** (~24, the ChatKit set plus Progress, Stat, ListItem, Automation) bound to **typed state** via bindings; the protocol is built on **Google's A2UI** rather than a proprietary format. The Agent instantiates and patches, it does not generate markup. Every Atom action declares its path: **fast path** (deterministic mutation + event in the log, zero LLM) or **agent path**.

Rationale: (1) persistent Surfaces must be updatable via diffs — free-form HTML cannot be patched reliably; (2) visual consistency is the differentiator, and with a catalog we own the design system; (3) A2UI is an existing open spec: interop and a magnet for contributors. Good compositions become saved and reused **Templates** (consistency across regenerations).

Status: accepted

## Considered Options
- Free-form generated HTML/JSX in a sandbox: rejected for v1 — not diffable, inconsistent, hallucination-prone. It returns post-v1 only as a sandboxed escape hatch for the long tail.
- Hardcoded domain components (meal-card, weight tracker): rejected — they betray GenUI genericity; domains emerge from composition, not from code.
