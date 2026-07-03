# 002 — Surface protocol (`protocol` package)

## Context
[ADR-0003](../docs/adr/0003-declarative-atoms.md): Surface = tree of Atoms + typed state + bindings, built on A2UI.

## Goal
The shared daemon↔PWA schema defining Surfaces, Atoms, state, actions, and patches.

## Tasks
- Study the Google A2UI v0.9 spec and decide: direct adoption, extension, or mapping (document the choice in an ADR if we deviate)
- Schema (zod/TypeBox → JSON Schema) for: `Surface` (id, spaceId, tree, state, freshness), `AtomNode` (type, props, bindings, actions), `Action` (`path: "fast" | "agent"`, payload), `Patch` (JSON-Patch-like state patches and tree patches)
- Atom type catalog v1: ChatKit set (~24: Button, DatePicker, Select, Checkbox, RadioGroup, Input, Textarea, Form, Box, Row, Col, Spacer, Divider, Table, Text, Title, Caption, Label, Markdown, Image, Icon, Chart, Badge, Transition) + `Progress`, `Stat`, `ListItem`, `Automation`
- Runtime validation of every Surface produced by the Agent (rejection with a readable error, never silent partial rendering)

## Acceptance criteria
- An example Surface (shopping checklist + chart) validates, serializes, and round-trips
- A tree with an unknown Atom or a broken binding is rejected with an actionable message
- Every action declares `fast` or `agent`; the default is `agent` (fail-safe)

## Dependencies
001
