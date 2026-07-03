# 006 — Spaces engine and three-layer memory

## Context

[ADR-0002](../docs/adr/0002-single-agent-spaces.md), [ADR-0006](../docs/adr/0006-file-based-memory.md). Glossary in [CONTEXT.md](../CONTEXT.md).

## Goal

Space lifecycle and file-based memory with a Curator.

## Tasks

- On-disk layout: `spaces/<slug>/{FACTS.md, INSTRUCTIONS.md, log/, surfaces/}` + global `USER.md`, `SOUL.md`
- Lifecycle: propose→confirm (one-tap from chat), archive (never delete), merge of two Spaces; granularity rule in the Agent's prompt (Space = life area; goals = Surfaces)
- Bi-temporal FACTS: every fact with a `noted:` date; `## Superseded` section (never deletion); tolerant parser
- **AUDN Curator**: `write_fact` tool that compares against the existing FACTS and decides Add/Update/Supersede/Noop on write
- Append-only Event log per Space (`log/YYYY-MM-DD.jsonl`): events from the fast path and from turns; `append_event`, `read_recent`, `search_log` APIs
- Per-turn context assembly: SOUL + USER + FACTS of the active Space + recent events + INSTRUCTIONS; abstention rule in SOUL
- "What I know about you here" Surface: FACTS visible and editable by the user (via issues 007/008)

## Acceptance criteria

- "I hate celery" then "I like celery now" → a single active fact, the old one in Superseded with dates
- Events written by the fast path appear in the next turn's context (memory contract, [ADR-0003](../docs/adr/0003-declarative-atoms.md))
- An archived Space disappears from the Home but its memory remains queryable after restore
- Question about an absent fact → the Agent states it does not know (test with fixture)

## Dependencies

001, 003
