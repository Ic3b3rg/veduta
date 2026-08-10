# Research 12 — Guided provisioning in the Hermes installer

> Conducted 2026-08-10 against a **shallow clone** of
> [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (a shallow clone has
> no fixed commit SHA to pin -- HEAD of the default branch at analysis time). Scope: how Hermes's
> dev script (`setup-hermes.sh`) and production installer (`scripts/install.sh`) decide what to
> auto-install silently versus ask about, how the installer reports progress to a caller (the
> `--manifest`/stage-protocol precedent this repo's `deploy/install.sh` already follows), and how
> the CLI on top of it wires up provider auth (device-code OAuth, an existing CLI's credentials,
> shelling out to an already-installed provider CLI). This informed folding Codex binary
> provisioning into `deploy/install.sh`'s `build` stage (issue #48).

## Finding

Hermes draws one consistent line: auto-install silently whenever the action is user-scoped and
needs no elevated privilege, ask (with a stated reason) only when `sudo` is actually required, and
never let one optional piece -- a provider CLI, a browser binary -- abort the whole setup. Every
failure prints a warning plus the exact manual command to finish the job by hand. That is the
shape this repo's Codex fold copies: `deploy/codex-setup.sh` already ran silently with `--yes`;
folding it into `build_stage` just moves the decision earlier and makes a failure non-fatal there
too, exactly as Hermes treats an optional dependency.

## A. Dependency provisioning: silent vs. ask

- `uv` is installed automatically with no prompt whenever it's missing
  (`setup-hermes.sh:84-125`); Python, resolved through `uv`, is likewise silent
  (`setup-hermes.sh:151-163`).
- Node.js is pinned to a specific major (22), fetched as a tarball into `~/.hermes/node`, and
  never prompts (`scripts/install.sh:60`, `820-975`) -- the same "pin an exact version, unpack into
  a user-owned tree, no prompt" idiom `deploy/install.sh`'s `build_stage` already uses for Node.
- `ripgrep`/`ffmpeg`: the **dev** script asks `[Y/n]` (`setup-hermes.sh:280` -- the default-yes
  convention this change copies for `deploy/local-vps.sh`'s Codex offer). The **production**
  installer instead installs silently when already root or when passwordless `sudo` is available,
  and only asks -- explaining why `sudo` is needed -- otherwise (`scripts/install.sh:1131-1179`),
  with a manual-command fallback printed on any failure (`scripts/install.sh:1205-1222`).
- Playwright's Chromium download (`npm`/`npx`) runs **without** asking, is time-boxed, has a
  `--skip-browser` opt-out flag, and never aborts setup on failure
  (`scripts/install.sh:2273-2386`, `105-108`). This is the closest precedent to the Codex fold:
  an npm-installed binary, silent by default, skippable by flag, failure is a warning.

## B. Stage protocol precedent

- `--manifest` emits JSON describing each stage, including a `needs_user_input` flag
  (`scripts/install.sh:315-325`), hard-coded true only for the two genuinely interactive stages
  (`setup` and `gateway`, `:329-334`) -- the same one-flag-for-the-whole-run shape
  `InstallerStageEventSchema` already uses in this repo.
- `--non-interactive` skips exactly those two stages, each reported `{"ok":true,"skipped":true}`
  rather than omitted (`scripts/install.sh:3291-3297`) -- mirrors this repo's `pairing` stage
  reporting `skipped` (not omitted) once a passkey is already registered.
- Each stage runs in its own subshell so a helper's exit can never kill the parent process before
  its JSON result frame is written (`scripts/install.sh:3299-3318`) -- the same reason this
  repo's Codex fold must never be a bare `run` call: a subprocess failure there must not raise
  through `set -e` into the stage's own JSON transition.

## C. Provider connection flows

- **Device-code OAuth UX skeleton** (RFC 8628): print the verification URL and the user code
  together, report whether a browser was opened, then `Waiting for approval (polling every {n}s)
...`, honoring `authorization_pending`/`slow_down` with a client-side poll cap and an actionable
  timeout message that includes the retry command
  (`hermes_cli/auth.py:8782-8858`, `5130-5217`, `5157-5173`). This is the shape Veduta's own
  ChatGPT subscription connection (issue #47) already follows in the PWA.
- **Codex**: Hermes does not shell out to the `codex` npm CLI for auth at all -- it reimplements
  the device-code flow itself (`hermes_cli/auth.py:7748-8157`). Where it does touch an existing
  Codex install, it offers to import `~/.codex/auth.json` with the confirmation **defaulting to
  No**: "Hermes will create its own session to avoid conflicts" (`:7784-7802`) -- the general
  principle (default to the safer, more isolated choice; only opt into reuse) rather than a
  literal pattern this repo follows, since Veduta's Codex integration provisions its own pinned
  binary rather than importing another agent's session.
- **Claude**: Hermes shells out to an _already-installed_ `claude setup-token` -- it never invokes
  `npm install -g @anthropic-ai/claude-code` itself. If the binary is missing, it prints the exact
  install command and stops (`hermes_cli/main.py:4496-4574`,
  `agent/anthropic_adapter.py:1415-1442`). This is the load-bearing precedent for point D below.

## D. Never block on one provider; never global-install a provider CLI

- A provider connection failing during setup never blocks the wizard from finishing
  (`setup.py:3200-3203`).
- Hermes never runs `npm install -g` for a provider CLI on the user's behalf, for any provider
  (C above) -- only a user-scoped install (Playwright's Chromium, A above) is ever silent;
  anything global or system-wide is either asked about (with the sudo rationale) or left to a
  printed manual command.
- Configuration is backed up, timestamped, before any write (`setup.py:2967-2980`), and a
  provider/model pair is written atomically together (`hermes_cli/auth.py:9083-9196`) -- config
  changes are never left half-applied.

## What this repo's Codex fold takes from it, and what it deliberately doesn't

`deploy/codex-setup.sh`'s own `npm install --prefix <dataDir>/codex/vendor` is exactly the
"user/data-directory-scoped npm install, not global" shape A and D both endorse, so folding it
into `build_stage` needed no change to what it installs -- only to _when_ and _how failure is
handled_. `deploy/install.sh` never drops privilege via `runuser`/`sudo -u`/`su` anywhere (every
stage, including `build`, runs as root throughout), unlike Hermes's own root-vs-sudo branch (A);
the fold keeps that as-is and instead adds an explicit `chown veduta:veduta` after a successful
provision, since a root-run `npm install` would otherwise leave the daemon's own data directory
holding root-owned files. Per D and the Playwright precedent, a failure here is a warning with the
exact retry command, never a failed `build` stage -- the one deliberate difference from Node
earlier in the same stage, which must still be fatal (there is no daemon without it).
