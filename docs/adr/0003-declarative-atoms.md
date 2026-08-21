# Surfaces = a tree of declarative Atoms from a closed catalog, never free-form HTML

A Surface is a declarative tree of **Atoms** (~24, the ChatKit set plus Progress, Stat, ListItem, Automation) bound to **typed state** via bindings; the protocol is built on **Google's A2UI** rather than a proprietary format. The Agent instantiates and patches, it does not generate markup. Every Atom action declares its path: **fast path** (deterministic mutation + event in the log, zero LLM) or **agent path**.

Rationale: (1) persistent Surfaces must be updatable via diffs — free-form HTML cannot be patched reliably; (2) visual consistency is the differentiator, and with a catalog we own the design system; (3) A2UI is an existing open spec: interop and a magnet for contributors. Good compositions become saved and reused **Templates** (consistency across regenerations).

Status: accepted

## Issue 002 protocol mapping

For v1 we use an A2UI-inspired mapping rather than direct adoption of OpenClaw-style Canvas markup (`a2ui-component`, `a2ui-action`, declarative HTML). Direct adoption would reintroduce generated markup into the persistent Home, conflicting with the closed Atom catalog and typed state contract.

Mapping:

- A2UI component → `AtomNode` (`type`, JSON `props`, `children`)
- A2UI action → `Action` (`name`, `path: "fast" | "agent"`, JSON `payload`)
- Component state → `Surface.state`, addressed by Atom `binding`
- Incremental updates → `Patch` operations scoped to `state` or `tree`

The compatibility target is conceptual: agents can produce structured UI actions and components, while Veduta keeps persistence, validation, and rendering under the local protocol.

## Issue 029 progressive composition

Progressive composition is a usage pattern inside the existing Surface contract, not a second
streaming format. The Agent creates the complete layout with typed `Pending` leaf Atoms, then
replaces each leaf with a separate versioned tree patch as content becomes ready. A replacement
preserves the Atom id so the catalog applies entrance motion only to that region.

The daemon owns the start of each Pending window. On creation, or when a patch inserts a Pending
subtree, it stamps `props.startedAt` with its own clock; a supplied value is overwritten. The
catalog computes the remaining time from that persisted timestamp and `timeoutMs`, so reloads and
remounts cannot restart an ordinary composition window. An unstamped or malformed Pending Atom is
shown immediately as a visible unavailable state. `startedAt` remains optional in the input schema
so Agent tool calls can omit server-owned metadata before the daemon validates and persists the
canonical tree.

Tree patches still replace and validate the complete Surface value. The catalog therefore
memoizes unchanged Atom subtrees by their rendered inputs (tree data, bound state, theme, relevant
motion update, and action dispatch). This preserves correctness for interactive or state-bound
regions while preventing already-filled siblings from rendering again during later fills. A stable
dispatch proxy forwards interactions to the latest host callback, so an unchanged interactive
region does not need to render merely because its host closure changed.

The rejected alternative remains a node-stream parser: it would duplicate validation and trust
boundaries without improving the user-visible result. A mount-relative timer was also rejected
because remounting could keep a skeleton alive indefinitely.

## Considered Options

- Free-form generated HTML/JSX in a sandbox: rejected for v1 — not diffable, inconsistent, hallucination-prone. It returns post-v1 only as a sandboxed escape hatch for the long tail.
- Hardcoded domain components (meal-card, weight tracker): rejected — they betray GenUI genericity; domains emerge from composition, not from code.
