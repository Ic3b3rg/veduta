#!/usr/bin/env bash
# Guided provisioning for the pinned Codex binary the ChatGPT subscription Model connection
# needs (issue #47, issues/047-model-connections.md; docs/adr/0014-subscription-inference-boundary.md).
# `packages/daemon/src/codex-app-server.ts`'s `resolveCodexBinary` looks for a binary at
# `VEDUTA_CODEX_BIN` (an absolute path override) or `<dataDir>/codex/bin/codex` (the convention
# this script provisions) and refuses anything that is not exactly `CODEX_PINNED_VERSION` --
# a strict hand-transcribed JSON-RPC schema is only as safe as the version it was transcribed
# from. Before this script existed, enabling the connection method meant hand-running `npm
# install` and a systemd restart on the instance -- this is the guided replacement, so a user
# never has to do that by hand. Issue #48 (docs/references/09-hermes-human-observability.md's
# discipline) will fold this same flow into the guided VPS access installer as one more offered
# step; until then this script is both the standalone command and what
# deploy/local-vps.sh offers interactively on first boot.
#
# Usage:
#   deploy/codex-setup.sh [--data-dir <path>] [--yes] [--help]
#
# Modes (docs/references/04-onboarding-migration.md §C): interactive with detected defaults,
# a PLAN printed and confirmed before any mutation, non-TTY without --yes is preview-only (exit
# 0, no changes), and every dead end below prints the exact next command to run.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------------------

CODEX_PINNED_VERSION='0.146.1' # must match packages/daemon/src/codex-app-server.ts's CODEX_PINNED_VERSION
CODEX_PACKAGE="@openai/codex@$CODEX_PINNED_VERSION"

DEFAULT_DATA_DIR="$HOME/.veduta-local-vps/data"
DATA_DIR="$DEFAULT_DATA_DIR"
ASSUME_YES=false

# --- Usage -------------------------------------------------------------------------------

usage() {
  cat >&2 <<EOF
Codex binary provisioning for the ChatGPT subscription Model connection (issue 047, ADR-0014)

Usage:
  deploy/codex-setup.sh [--data-dir <path>] [--yes] [--help]

Options:
  --data-dir <path> Data directory whose codex/ subtree gets provisioned (default: $DEFAULT_DATA_DIR).
                     This is the Local VPS profile's data dir (deploy/local-vps.sh: \$BASE_DIR/data,
                     default base dir \$HOME/.veduta-local-vps). For a production install (deploy/install.sh),
                     pass its data dir instead -- default /var/lib/veduta/.veduta, or whatever --data-dir
                     that installer was given.
  --yes              Skip the confirmation prompt and apply the plan immediately.
  --help             Show this help

Installs a pinned $CODEX_PACKAGE into <data-dir>/codex/vendor and symlinks
<data-dir>/codex/bin/codex to it. The daemon refuses any Codex binary that does not report
exactly $CODEX_PINNED_VERSION.

With no controlling tty and no --yes, this prints the plan and makes no changes (exit 0) --
preview first, mutate only on request or explicit confirmation.
EOF
}

# --- Argument parsing --------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir)
      if [ $# -lt 2 ]; then
        printf 'error: --data-dir requires an argument\n' >&2
        usage
        exit 64
      fi
      DATA_DIR="$2"
      shift 2
      ;;
    --yes)
      ASSUME_YES=true
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage
      exit 64
      ;;
  esac
done

TARGET_BIN="$DATA_DIR/codex/bin/codex"
VENDOR_DIR="$DATA_DIR/codex/vendor"
BIN_DIR="$DATA_DIR/codex/bin"

STAGE_NUM=0
TOTAL_STAGES=6
stage() {
  STAGE_NUM=$((STAGE_NUM + 1))
  printf '\n[%s/%s] %s\n' "$STAGE_NUM" "$TOTAL_STAGES" "$1" >&2
}

# --- Stage 1: detect node + npm -----------------------------------------------------------

stage "Detecting node and npm"

install_hint() {
  case "$(uname -s)" in
    Darwin)
      if command -v brew >/dev/null 2>&1; then
        printf 'brew install node\n'
      else
        printf 'install Homebrew (https://brew.sh) then: brew install node -- or download the LTS installer from https://nodejs.org/en/download\n'
      fi
      ;;
    Linux)
      printf 'sudo apt-get update && sudo apt-get install -y nodejs npm  (or see https://nodejs.org/en/download for other distros)\n'
      ;;
    *)
      printf 'install Node.js and npm from https://nodejs.org/en/download\n'
      ;;
  esac
}

if ! command -v node >/dev/null 2>&1; then
  printf 'error: node is not on PATH\n' >&2
  printf 'run: %s' "$(install_hint)" >&2
  exit 69
fi
if ! command -v npm >/dev/null 2>&1; then
  printf 'error: npm is not on PATH\n' >&2
  printf 'run: %s' "$(install_hint)" >&2
  exit 69
fi
printf 'found node %s, npm %s\n' "$(node --version)" "$(npm --version)" >&2

# --- Stage 2: detect an existing binary ---------------------------------------------------

stage "Checking for an existing Codex binary"

CHECK_BIN="${VEDUTA_CODEX_BIN:-$TARGET_BIN}"
REPLACING=false

if [ -x "$CHECK_BIN" ]; then
  version_output=$("$CHECK_BIN" --version 2>&1) || version_output="(failed to run: $CHECK_BIN --version)"
  if printf '%s' "$version_output" | grep -q "$CODEX_PINNED_VERSION"; then
    printf '%s reports "%s" -- already provisioned, nothing to do\n' "$CHECK_BIN" "$version_output" >&2
    exit 0
  fi
  printf '%s reports "%s" -- not the pinned %s\n' "$CHECK_BIN" "$version_output" "$CODEX_PINNED_VERSION" >&2
  if [ "$CHECK_BIN" != "$TARGET_BIN" ]; then
    printf 'note: VEDUTA_CODEX_BIN is set to %s, which takes precedence over %s -- unset it (or point it at the pinned binary) after this script finishes, or the daemon keeps using the one found above\n' \
      "$CHECK_BIN" "$TARGET_BIN" >&2
  fi
  REPLACING=true
else
  printf 'no existing binary found at %s\n' "$CHECK_BIN" >&2
fi

# --- Stage 3: show the plan and confirm ----------------------------------------------------

stage "Plan"

print_plan() {
  printf '  install: npm install --prefix %s %s --no-fund --no-audit --loglevel=error\n' "$VENDOR_DIR" "$CODEX_PACKAGE" >&2
  printf '  symlink: %s -> ../vendor/node_modules/.bin/codex\n' "$TARGET_BIN" >&2
  if [ "$REPLACING" = "true" ]; then
    printf '  (this replaces the mismatched binary found above)\n' >&2
  fi
}

print_plan

if [ "$ASSUME_YES" != "true" ]; then
  if [ ! -t 0 ]; then
    printf '\nno controlling tty and --yes not given -- preview only, no changes made\n' >&2
    printf 're-run with --yes to apply: deploy/codex-setup.sh --data-dir %s --yes\n' "$DATA_DIR" >&2
    exit 0
  fi
  printf '\nProceed? [Y/n] ' >&2
  IFS= read -r answer
  case "$answer" in
    '' | y | Y | yes | Yes | YES) ;;
    *)
      printf 'aborted -- no changes made\n' >&2
      exit 0
      ;;
  esac
fi

# --- Stage 4: install ----------------------------------------------------------------------

stage "Installing $CODEX_PACKAGE"

mkdir -p "$VENDOR_DIR"
npm install --prefix "$VENDOR_DIR" "$CODEX_PACKAGE" --no-fund --no-audit --loglevel=error

mkdir -p "$BIN_DIR"
chmod 0755 "$BIN_DIR"
# Relative symlink, so the data dir can be relocated (e.g. copied to a new host, backed up)
# without the link pointing outside its own tree. `-sfn`: atomic replace, never follows an
# existing symlink at the target (`-n`), so a rerun always repoints cleanly.
ln -sfn '../vendor/node_modules/.bin/codex' "$TARGET_BIN"

# --- Stage 5: verify -------------------------------------------------------------------------

stage "Verifying the pinned version"

# The daemon refuses any Codex binary that does not report exactly CODEX_PINNED_VERSION
# (packages/daemon/src/codex-app-server.ts's resolveCodexBinary plus the exact-pin rationale
# in docs/adr/0014-subscription-inference-boundary.md's amendment: a strict hand-transcribed
# JSON-RPC schema is only as safe as the version it was transcribed from) -- so this script
# must fail loudly, not just install-and-hope, whenever the installed binary disagrees.
verify_output=$("$TARGET_BIN" --version 2>&1) || verify_output="(failed to run: $TARGET_BIN --version)"
if ! printf '%s' "$verify_output" | grep -q "$CODEX_PINNED_VERSION"; then
  rm -f "$TARGET_BIN"
  printf 'error: %s reports "%s" -- expected %s\n' "$TARGET_BIN" "$verify_output" "$CODEX_PINNED_VERSION" >&2
  printf 'the symlink has been removed. Fix: remove the vendor install and rerun:\n' >&2
  printf '  rm -rf %s\n  deploy/codex-setup.sh --data-dir %s --yes\n' "$VENDOR_DIR" "$DATA_DIR" >&2
  exit 65
fi
printf '%s reports "%s" -- pinned version confirmed\n' "$TARGET_BIN" "$verify_output" >&2

# --- Stage 6: next steps ---------------------------------------------------------------------

stage "Next steps"

RESTART_SERVICE=""
for svc in veduta-local veduta; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    RESTART_SERVICE="$svc"
    break
  fi
done

if [ -n "$RESTART_SERVICE" ]; then
  printf '1. Restart the daemon so it picks up the new binary:\n     sudo systemctl restart %s\n' "$RESTART_SERVICE" >&2
else
  printf '1. Restart your daemon so it picks up the new binary (no active systemd unit named veduta-local or veduta was found on this host).\n' >&2
fi

printf '2. In the PWA: Model connections -> add OpenAI -- ChatGPT subscription. Device-code login\n' >&2
printf '   must be enabled in the ChatGPT account security settings first:\n     https://developers.openai.com/codex/auth\n' >&2
printf '3. Firewall note: the Codex child process makes its own outbound connections that the\n' >&2
printf '   daemon cannot intercept -- auth.openai.com, chatgpt.com, and api.openai.com must be\n' >&2
printf '   reachable from this host for the connection to work (docs/SECURITY.md sec 3.4).\n' >&2
