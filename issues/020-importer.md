# 020 — Importer from OpenClaw and Hermes

## Context
[Ref. 04](../docs/references/04-onboarding-migration.md): the importer is an acquisition weapon; the discipline standard is the Hermes migration.

## Goal
An OpenClaw or Hermes user brings their memory and configuration into our Spaces, safely.

## Tasks
- Sources: `~/.openclaw` (workspace: `SOUL.md`, `MEMORY.md`, `USER.md`, daily notes, `openclaw.json`; legacy `.clawdbot`/`.moltbot`) and `~/.hermes` (`SOUL.md`, `memories/`, `config.yaml`)
- Mapping: SOUL → SOUL (with adaptation), USER → USER, MEMORY/notes → FACTS + Event log of an "Imported" Space (the user then sorts them; the Curator helps distribute the facts into the right Spaces via chat)
- Non-negotiable discipline: **always dry-run** with a grouped preview (import/overwrite/skip) and warnings for high-impact items; **atomic backup** before every mutation; **secrets only with an explicit flag** and allowlist; conflicts without `--overwrite` → refusal, never a silent skip; a generated `NOTES.md` with what was archived and must be recreated by hand
- Integration into the wizard (issue 019) + standalone CLI

## Acceptance criteria
- Import from a real `~/.hermes`: FACTS populated, SOUL adapted, zero secrets migrated without the flag, restorable backup created
- Second run without `--overwrite` on an already-migrated installation → refusal with an actionable message
- Non-TTY → preview only, no mutation

## Dependencies
006, 019
