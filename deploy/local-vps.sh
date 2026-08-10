#!/usr/bin/env bash
# Runner for the Local VPS profile (issue 023, docs/adr/0009-local-vps-profile.md): builds the
# PWA, then supervises `pnpm --filter @veduta/daemon exec tsx src/index.ts` with
# VEDUTA_PROFILE=local-vps so it boots with real passkey auth over http://localhost instead of
# the pnpm dev loopback profile's dev token and mock auth. This is the dev-facing stand-in for
# the systemd `Restart=always` unit deploy/install.sh installs on a real VPS: the onboarding
# wizard's finish step makes the daemon exit(0) on purpose (packages/daemon/src/server.ts's
# `defaultScheduleExit`) expecting a supervisor to restart it with the now-current config, and
# this loop is that supervisor when running locally.
#
# Usage:
#   deploy/local-vps.sh [--port <n>] [--base-dir <path>] [--help]
#
# Everything the daemon itself prints (the ready line, the first-boot setup URL) passes through
# to this script's own stdout/stderr untouched -- only this runner's own notices (restart,
# shutdown, failure) are written here, and always to stderr, never mixed into the daemon's own
# output.
#
# This script never deletes anything: no --fresh flag, no `rm` of any user path. The vault
# keyfile in particular is generated once and never rotated in place -- see the comment above
# `ensure_vault_keyfile` below.
#
# On first boot against a fresh data dir, and only when a controlling tty is attached, this
# also offers once to provision the ChatGPT subscription connection method via
# deploy/codex-setup.sh -- see the comment above that offer below.

set -euo pipefail

# --- Defaults ---------------------------------------------------------------------------

DEFAULT_PORT=8788
DEFAULT_BASE_DIR="$HOME/.veduta-local-vps"

PORT="$DEFAULT_PORT"
BASE_DIR="$DEFAULT_BASE_DIR"

# --- Usage -------------------------------------------------------------------------------

usage() {
  cat >&2 <<EOF
Veduta Local VPS profile runner (issue 023, docs/adr/0009-local-vps-profile.md)

Usage:
  deploy/local-vps.sh [--port <n>] [--base-dir <path>] [--help]

Options:
  --port <n>        Port the daemon listens on (default: $DEFAULT_PORT)
  --base-dir <path> Base directory for data/ and vault.key (default: $DEFAULT_BASE_DIR)
  --help            Show this help

Builds the PWA, then supervises the daemon under VEDUTA_PROFILE=local-vps, restarting it
whenever it exits 0 (the onboarding wizard's finish step does this on purpose so the new
config takes effect). A nonzero exit stops the loop and is propagated as this script's own
exit code. Ctrl-C (SIGINT) or SIGTERM stops the daemon and this runner cleanly.
EOF
}

# --- Argument parsing --------------------------------------------------------------------

while [ $# -gt 0 ]; do
  case "$1" in
    --port)
      if [ $# -lt 2 ]; then
        printf 'error: --port requires an argument\n' >&2
        usage
        exit 64
      fi
      PORT="$2"
      if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
        printf 'error: --port must be an integer between 1 and 65535, got: %s\n' "$PORT" >&2
        usage
        exit 64
      fi
      shift 2
      ;;
    --base-dir)
      if [ $# -lt 2 ]; then
        printf 'error: --base-dir requires an argument\n' >&2
        usage
        exit 64
      fi
      BASE_DIR="$2"
      shift 2
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

# --- Locate the repo root from this script's own path (same pattern as deploy/install.sh's
# preview-mode version lookups) -----------------------------------------------------------

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)
cd "$REPO_ROOT"

# --- Preconditions -------------------------------------------------------------------------

if ! command -v pnpm >/dev/null 2>&1; then
  printf 'error: pnpm is not on PATH -- install it first (see AGENTS.md: pnpm only, never npm or yarn)\n' >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  printf 'error: node_modules not found at %s\n' "$REPO_ROOT/node_modules" >&2
  printf 'run: pnpm install\n' >&2
  exit 1
fi

# --- Layout under the base directory --------------------------------------------------------
#
# data/     -- VEDUTA_DATA_DIR, created once and never removed by this script.
# vault.key -- VEDUTA_VAULT_KEYFILE, generated once if absent, same key-material shape as
#              deploy/README.md §2 (48 random bytes, base64-encoded). Never regenerated: rotating
#              it in place would orphan the vault it decrypts, exactly as deploy/install.sh never
#              rotates an existing /etc/veduta/vault.key.

DATA_DIR="$BASE_DIR/data"
VAULT_KEYFILE="$BASE_DIR/vault.key"

printf 'Local VPS profile base directory: %s\n' "$BASE_DIR" >&2

mkdir -p "$DATA_DIR"
chmod 0700 "$DATA_DIR"

ensure_vault_keyfile() {
  # Refuse to follow a symlink at the keyfile path -- checked before the
  # existence check below so a symlink can never be mistaken for (or
  # silently treated as) an ordinary already-generated keyfile.
  if [ -L "$VAULT_KEYFILE" ]; then
    printf 'error: %s is a symlink -- refusing to follow it\n' "$VAULT_KEYFILE" >&2
    exit 1
  fi
  if [ -f "$VAULT_KEYFILE" ]; then
    return 0
  fi
  printf 'generating vault keyfile: %s\n' "$VAULT_KEYFILE" >&2
  local tmp
  tmp=$(mktemp "$BASE_DIR/.vault.key.XXXXXX")
  (
    umask 077
    head -c 48 /dev/urandom | base64 >"$tmp"
  )
  # `ln` publishes the candidate atomically: hard-linking fails (EEXIST) if
  # a concurrent run created the keyfile first, with no check-then-rename
  # window (`mv -n` has one on both GNU and BSD). Losing the race just means
  # deferring to the file already in place: never rotate a key that might
  # already be protecting a vault. The scratch name is always discarded --
  # after a win it is a second hard link to the published keyfile.
  ln "$tmp" "$VAULT_KEYFILE" 2>/dev/null || true
  rm -f "$tmp"
  # Whatever won the race must be an ordinary file: a directory or a
  # raced-in symlink at this path must never be chmod'd or silently used as
  # the vault key.
  if [ -L "$VAULT_KEYFILE" ] || [ ! -f "$VAULT_KEYFILE" ]; then
    printf 'error: %s is not a regular file after keyfile publication\n' "$VAULT_KEYFILE" >&2
    exit 1
  fi
  chmod 0400 "$VAULT_KEYFILE"
}

ensure_vault_keyfile

# --- Offer to provision the ChatGPT subscription Model connection (issue #47, deploy/codex-
# setup.sh) --------------------------------------------------------------------------------
#
# Asked at most once per data dir: a "no" writes a marker file so this never nags on every
# subsequent boot, and is silently skipped outright when there is no controlling tty (a
# non-interactive run, e.g. under a supervisor) or when VEDUTA_CODEX_BIN already points somewhere
# -- either way there is nothing useful to ask.

CODEX_SETUP_MARKER="$DATA_DIR/codex/.setup-declined"

if [ ! -e "$DATA_DIR/codex/bin/codex" ] && [ -z "${VEDUTA_CODEX_BIN:-}" ] && [ -t 0 ] &&
  [ ! -e "$CODEX_SETUP_MARKER" ]; then
  printf 'Enable the ChatGPT subscription connection method (installs the pinned @openai/codex 0.146.1 into the data dir)? [y/N] ' >&2
  IFS= read -r codex_setup_answer
  case "$codex_setup_answer" in
    y | Y | yes | Yes | YES)
      "$REPO_ROOT/deploy/codex-setup.sh" --data-dir "$DATA_DIR" --yes
      ;;
    *)
      mkdir -p "$(dirname "$CODEX_SETUP_MARKER")"
      : >"$CODEX_SETUP_MARKER"
      printf 'You can enable it later: deploy/codex-setup.sh --data-dir %s\n' "$DATA_DIR" >&2
      ;;
  esac
fi

# --- Build the PWA (the daemon serves packages/pwa/dist/) -----------------------------------

printf 'building the PWA...\n' >&2
pnpm --filter @veduta/pwa build 1>&2

# --- Hand off to the shared supervisor (issue #43, docs/adr/0013-signed-self-update.md) ------
#
# `deploy/veduta-run` now owns the restart loop this script used to run inline: the process
# group + signal forwarding + exit-code handling (`set -m`, INT/TERM trap, exit 0 restarts, exit
# 75 re-checks for an update, anything else propagates) is exactly the idiom this script used to
# implement itself, plus the update/rollback dance when VEDUTA_UPDATE_HOME has a transaction in
# flight. `VEDUTA_LEGACY_ROOT="$REPO_ROOT"` is this profile's "release": there is no
# releases/current symlink under `$BASE_DIR/updates` until a first update actually runs, so
# veduta-run falls back to running straight out of this checkout, exactly as before.
#
# `exec` replaces this process outright, so everything from here on is veduta-run's own
# stdout/stderr, unmodified -- which is what packages/e2e/tests/stack.ts's ready-line/setup-URL
# regexes rely on. `env -u`/passthrough rules are unchanged from what this script always did (see
# the comment that used to sit above the old inline loop): VEDUTA_AUTH_STATE/VEDUTA_VAULT_KEY are
# cleared before the profile env is applied so a stray value from the caller's shell can never
# silently break the --base-dir isolation this script exists to provide; VEDUTA_BOOTSTRAP_CODE
# and VEDUTA_PUBLIC_DOMAIN are left untouched (deliberate operator input, and the daemon itself
# refuses VEDUTA_PROFILE=local-vps together with a public domain -- packages/daemon/src/profile.ts).

printf 'starting daemon on http://localhost:%s (VEDUTA_DATA_DIR=%s)\n' "$PORT" "$DATA_DIR" >&2

exec env -u VEDUTA_AUTH_STATE -u VEDUTA_VAULT_KEY \
  VEDUTA_PROFILE=local-vps \
  VEDUTA_DATA_DIR="$DATA_DIR" \
  VEDUTA_VAULT_KEYFILE="$VAULT_KEYFILE" \
  PORT="$PORT" \
  VEDUTA_UPDATE_HOME="$BASE_DIR/updates" \
  VEDUTA_UPDATE_PINNING="$BASE_DIR/update.json" \
  VEDUTA_LEGACY_ROOT="$REPO_ROOT" \
  "$REPO_ROOT/deploy/veduta-run"
