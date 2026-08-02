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

# --- Build the PWA (the daemon serves packages/pwa/dist/) -----------------------------------

printf 'building the PWA...\n' >&2
pnpm --filter @veduta/pwa build 1>&2

# --- Supervision loop ------------------------------------------------------------------------
#
# `set -m` gives each backgrounded daemon its own process group, so a signal sent to the negated
# pid below reaches the daemon process and anything it spawned (tsx/node), not just the top-level
# pnpm process -- the same guarantee systemd's cgroup-scoped kill gives the VPS profile.

set -m

CHILD_PID=""

on_signal() {
  local sig="$1"
  printf 'received %s -- stopping the daemon\n' "$sig" >&2
  if [ -n "$CHILD_PID" ]; then
    kill -TERM "-$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
  exit 0
}

trap 'on_signal INT' INT
trap 'on_signal TERM' TERM

printf 'starting daemon on http://localhost:%s (VEDUTA_DATA_DIR=%s)\n' "$PORT" "$DATA_DIR" >&2

while true; do
  # `env -u` clears a stray VEDUTA_AUTH_STATE/VEDUTA_VAULT_KEY the caller's
  # shell might already have set, before the profile env below is applied --
  # otherwise either would silently break the --base-dir isolation this
  # script exists to provide (auth state written outside $BASE_DIR, or the
  # vault opened with foreign key material instead of $VAULT_KEYFILE).
  # VEDUTA_BOOTSTRAP_CODE is passed through untouched: it is deliberate
  # operator input (a fixed bootstrap code for a scripted first boot), not
  # runner state to isolate. VEDUTA_PUBLIC_DOMAIN needs no unset either --
  # the daemon itself refuses VEDUTA_PROFILE=local-vps together with a public
  # domain (packages/daemon/src/profile.ts).
  env -u VEDUTA_AUTH_STATE -u VEDUTA_VAULT_KEY \
    VEDUTA_PROFILE=local-vps \
    VEDUTA_DATA_DIR="$DATA_DIR" \
    VEDUTA_VAULT_KEYFILE="$VAULT_KEYFILE" \
    PORT="$PORT" \
    pnpm --filter @veduta/daemon exec tsx src/index.ts &
  CHILD_PID=$!

  if wait "$CHILD_PID"; then
    status=0
  else
    status=$?
  fi
  CHILD_PID=""

  if [ "$status" -eq 0 ]; then
    printf 'daemon exited cleanly (onboarding finish); restarting\n' >&2
    # Brief pause between restarts (systemd's RestartSec analogue): a bug
    # that produces repeated clean exits must not become a hot loop.
    sleep 1
    continue
  fi

  printf 'daemon exited with status %s\n' "$status" >&2
  printf 'rerun: deploy/local-vps.sh --port %s --base-dir %s\n' "$PORT" "$BASE_DIR" >&2
  exit "$status"
done
