# Research 04 — Installer, onboarding and migration: a study of the Hermes/OpenClaw repos

> Conducted on 2026-07-02/03 by cloning and reading the code (`NousResearch/hermes-agent`, Python; `openclaw/openclaw`, TypeScript). Informs issues `018-onboarding-wizard` and `019-importer`.

## A. Installer & onboarding

### Hermes
- `curl -fsSL .../install.sh | bash` (a 3,133-line script); PowerShell for Windows (portable MinGit, zero admin). Installs managed uv, Python 3.11, Node, ripgrep, ffmpeg; venv; symlinks; then the wizard.
- **Gem: a JSON stage protocol** (`{"protocol_version":1,"stages":[...]}` with a `needs_user_input` flag) — a GUI can render the installer's progress bar without reimplementing it. → To copy: our wizard lives in the PWA.
- `hermes setup` wizard (`hermes_cli/setup.py`, `run_setup_wizard()` line 2715): detects TTY; timestamped backup of `config.yaml` before touching it; a fresh install detects `~/.openclaw` and offers migration BEFORE configuring; 3 modes (Quick Setup with Nous OAuth, sectioned Full, Blank Slate); on an existing install every current value is the default; individual sections (`hermes setup model|gateway|...`).
- Files written: `config.yaml` (settings), `.env` (secrets only), `SOUL.md` from template, `memories/MEMORY.md` + `USER.md`, `skills/`.

### OpenClaw
- `openclaw onboard` (`src/commands/onboard*.ts`, `src/wizard/setup*.ts`): QuickStart vs Advanced; steps Model/Auth → Workspace (seeds `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md`) → Gateway (auto token even on loopback) → Channels → Daemon (LaunchAgent/systemd) → Health check → Skills.
- Symmetry: `openclaw onboard --flow import --import-from hermes` — but only on a virgin setup (more restrictive than Hermes).
- RPC `wizard.start/next/cancel/status`: multiple clients can render the onboarding. i18n en/zh.

## B. OpenClaw → Hermes migration (the standard to match)

Three entry points (onboarding, `hermes claw migrate`, an agentic skill), one engine: a 3,136-line script, **34 options**, presets `user-data`/`full`.

Mapping: `SOUL.md` → `SOUL.md` (with case-preserving rebranding), `MEMORY.md`+daily notes → merge with budget limits, `USER.md`, `AGENTS.md`, channels → `.env`, exec approvals → `command_allowlist`, skills → `skills/openclaw-imports/`; plugins/hooks/multi-agent/memory-backend → **archived** for manual review with a generated `NOTES.md`. Sessions: **not migrated** (no 1:1 mapping). Legacy name support (`.clawdbot`, `.moltbot`).

## C. Quality: to copy / to avoid

**To copy (Hermes discipline):**
1. **Mandatory preview-first + refusal on conflicts** — always dry-run; with conflicts and no `--overwrite`, it refuses instead of silently skipping. Non-TTY = preview only.
2. **Atomic, restorable backup before every mutation** (SQLite safe-copy, zip with auto-pruning at 5).
3. **Secrets never migrated implicitly** (not even with `--preset full`): explicit allowlist, redaction in reports, final notice with the exact command to import them.
4. **Every dead end prints the exact next command.**
5. **Warnings for high-impact items**: bot token takeover (it even detects running OpenClaw processes via pgrep/systemctl), non-1:1 semantics.

**To avoid (Hermes weaknesses):** monolithic files (`main.py` 13,657 lines, wizard 3,417) → OpenClaw-style structure: one file per step, test alongside. Fragile loading of the migration engine via importlib from a skill directory. Duplicated preview logic.

**Derived product requirement:** in this market users arrive from another agent — the importer is an acquisition weapon, and bidirectional migration is by now expected in the ecosystem.
