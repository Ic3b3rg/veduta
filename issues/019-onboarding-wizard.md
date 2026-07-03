# 019 — Installer + onboarding wizard in the PWA

## Context

[Ref. 04](../docs/references/04-onboarding-migration.md): Hermes-style stage protocol, OpenClaw-style step structure.

## Goal

From a clean VPS to a working Home in < 15 minutes, guided.

## Tasks

- `curl | bash` installer: dependencies (pinned Node), dedicated user, systemd unit, first boot; **emits the JSON stage protocol** (`{stages:[...], needs_user_input}`) on stdout
- Wizard rendered **in the PWA** (after passkey pairing via the QR printed by the installer): domain/TLS → BYOK (provider + key in the vault, test call) → model tiers with defaults → optional integrations (Gmail/Calendar) → first proposed Space
- Every step: current value as the default, config backup before every mutation, non-interactive = preview only (Hermes discipline)
- Detection of `~/.openclaw` / `~/.hermes` → migration offered BEFORE manual configuration (hooks into issue 020)
- Every dead end prints the exact next command/action

## Acceptance criteria

- Clean Ubuntu VPS + domain → working Home with passkey in < 15 timed minutes, without touching config files by hand
- Wizard interrupted midway: restart resumes from the right step, no corrupted state
- With `~/.hermes` present, migration is offered before manual setup

## Dependencies

005, 009, 010
