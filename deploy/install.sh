#!/usr/bin/env bash
# Veduta installer -- automates deploy/README.md §1-3 (user/group/directory layout, the
# secrets vault keyfile, and the systemd unit) plus Node install, checkout, build, first boot,
# and passkey pairing. See tasks/plan.md, design decision 10, for the authoritative contract.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh | sudo bash
#   sudo bash deploy/install.sh [--domain <d>] [--email <e>] [--repo <url>] [--ref <tag|sha>]
#                                [--data-dir <path>] [--apply] [--preview] [--help]
#
# Streams: a machine-readable JSON stage-protocol line (schema: InstallerStageEventSchema in
# @veduta/protocol) is written to stdout after every stage transition. Every human-readable
# message goes to stderr. Nothing on stdout is meant to be read by a human.
#
# Modes: interactive (a controlling tty is attached -- prompts read from /dev/tty, not stdin,
# because `curl | sudo bash` consumes stdin as the script itself); unattended apply (--apply
# with --domain and --email, no tty required); otherwise PREVIEW ONLY -- the full stage plan is
# printed (all stages "pending", needs_user_input true) and the script exits 0 having made no
# filesystem or network mutation. Preview safety is structural: every mutating command in every
# stage function is routed through the `run()` (or `run_quiet()`) wrapper below, which in
# preview mode only echoes the command to stderr; in addition, preview mode never calls the
# stage functions at all (see `run_preview`), so this is a belt-and-suspenders guarantee, not
# just a convention.
#
# Stage ids (stable, referenced by the PWA onboarding wizard and by tests): preflight,
# legacy-detect, deps, user-layout, checkout, build, vault-keyfile, systemd-unit, first-boot,
# pairing. Deviation from tasks/plan.md's decision-10 sketch, noted here for reviewers: Node
# installation (which needs the exact version pinned by the checked-out repo's .node-version)
# is folded into the "build" stage rather than added as its own "node" stage id, so the ids stay
# exactly the ten enumerated above -- plan.md explicitly allows this ("reordering is ALLOWED if
# you keep ids stable and documented").
#
# Supply-chain trust root: the repository is cloned over GitHub TLS and pinned to a concrete
# commit SHA (resolved with `git rev-parse` and hard-reset to, even when --ref names a branch or
# tag); the Node.js tarball is fetched over TLS from nodejs.org and verified against its
# published SHASUMS256.txt with sha256sum. Full release-signature verification (a GPG keyring
# for signed Veduta releases) is the SECURITY.md §6 "signed updates" follow-up and is
# deliberately out of scope here.
#
# This script must remain parseable by bash 3.2 (macOS's system bash) because the preview code
# path is exercised there by packages/daemon/src/installer-protocol.test.ts. That means no
# associative arrays, no `${var,,}` case conversion, and no other bash-4-only syntax anywhere in
# the file, not just in the preview path -- bash parses the whole script up front.

set -Eeuo pipefail

# --- Constants --------------------------------------------------------------------------

readonly INSTALL_URL="https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh"
readonly DEFAULT_REPO="https://github.com/Ic3b3rg/veduta.git"
readonly DEFAULT_DATA_DIR="/var/lib/veduta/.veduta"

# --- Stage table (parallel indexed arrays -- no associative arrays, for bash 3.2) ---------

STAGE_IDS=(preflight legacy-detect deps user-layout checkout build vault-keyfile systemd-unit first-boot pairing)
STAGE_TITLES=(
  "Preflight checks (root, OS, systemd)"
  "Detect legacy agent install"
  "Install OS packages"
  "Create system user and directory layout"
  "Checkout Veduta at a pinned commit"
  "Install Node.js and build"
  "Provision the secrets vault keyfile"
  "Install the systemd unit"
  "Enable the service and wait for readiness"
  "Print the pairing URL and QR code"
)
STAGE_STATUS=(pending pending pending pending pending pending pending pending pending pending)

# --- Global state (set by parse_args / determine_mode / stage functions) -----------------

REPO="$DEFAULT_REPO"
REF=""
DOMAIN=""
EMAIL=""
DATA_DIR="$DEFAULT_DATA_DIR"
EXPLICIT_APPLY=false
EXPLICIT_PREVIEW=false
SHOW_HELP=false
PREVIEW_MODE=false
RERUN_CMD=""

ADMIN_HOME=""
ADMIN_HOME_KNOWN=false
LEGACY_OPENCLAW=false
LEGACY_HERMES=false
RESOLVED_SHA=""
BOOTSTRAP_CODE=""
CURRENT_STAGE=""

# OpenClaw's former names (docs/references/04-onboarding-migration.md §B: "Legacy name
# support (.clawdbot, .moltbot)"). Mirrors packages/daemon/src/import-source.ts's exported
# OPENCLAW_ALIASES (B13, code review: the TypeScript side used to keep this list twice --
# packages/daemon/src/onboarding-status.ts now imports the one export instead of a second
# copy). This shell copy is the one duplication left standing on purpose: bash cannot import
# a TypeScript constant, so a plain string is the only way this installer -- which runs
# before Node/pnpm are even installed -- can know the same three names.
readonly OPENCLAW_HOME_ALIASES=".openclaw .clawdbot .moltbot"

# --- Stage protocol emission (printf-composed JSON, no jq dependency) ---------------------

set_stage_status() {
  local id="$1" status="$2" i n
  n=${#STAGE_IDS[@]}
  for ((i = 0; i < n; i++)); do
    if [ "${STAGE_IDS[$i]}" = "$id" ]; then
      STAGE_STATUS[i]="$status"
      return 0
    fi
  done
}

stage_status() {
  local id="$1" i n
  n=${#STAGE_IDS[@]}
  for ((i = 0; i < n; i++)); do
    if [ "${STAGE_IDS[$i]}" = "$id" ]; then
      printf '%s' "${STAGE_STATUS[$i]}"
      return 0
    fi
  done
}

stages_json_fragment() {
  local i n frag
  n=${#STAGE_IDS[@]}
  frag="["
  for ((i = 0; i < n; i++)); do
    if [ "$i" -gt 0 ]; then
      frag="$frag,"
    fi
    frag="$frag{\"id\":\"${STAGE_IDS[$i]}\",\"title\":\"${STAGE_TITLES[$i]}\",\"status\":\"${STAGE_STATUS[$i]}\"}"
  done
  frag="$frag]"
  printf '%s' "$frag"
}

event_json() {
  local needs="$1"
  printf '{"protocol_version":1,"stages":%s,"needs_user_input":%s}' "$(stages_json_fragment)" "$needs"
}

emit_event() {
  event_json "$1"
  printf '\n'
}

# `<dataDir>/installer-stages.json` -- the PWA onboarding wizard's installer summary
# (tasks/plan.md decision 10). Silently skipped when DATA_DIR does not exist yet (an early
# failure, before user-layout has run, has nowhere durable to write to).
write_stage_file() {
  local needs="$1" path tmp
  if [ ! -d "$DATA_DIR" ]; then
    return 0
  fi
  path="$DATA_DIR/installer-stages.json"
  tmp="$path.tmp.$$"
  event_json "$needs" | tee "$tmp" >/dev/null
  mv "$tmp" "$path"
  chown veduta:veduta "$path" 2>/dev/null || true
  chmod 0600 "$path" 2>/dev/null || true
}

# --- The mutation gate: every command with a filesystem/network/process side effect goes
# through one of these two wrappers, so preview mode (which never calls the stage functions
# anyway) is doubly safe, and apply mode's stdout stays exclusively the JSON stage protocol.

# For ordinary mutating commands (apt/git/pnpm/corepack/systemctl/...): their own stdout, if
# any, is redirected to stderr in apply mode so it never corrupts the line-oriented stage
# protocol on stdout.
run() {
  if [ "$PREVIEW_MODE" = "true" ]; then
    printf '[preview] would run: %s\n' "$*" >&2
    return 0
  fi
  "$@" 1>&2
}

# For commands whose own stdout carries secret material (writing the vault keyfile, the
# bootstrap pairing code, or the onboarding seed via `tee`): that output must never appear on
# *either* stream, so it is suppressed to /dev/null in apply mode instead of being redirected
# to stderr the way run() does.
run_quiet() {
  if [ "$PREVIEW_MODE" = "true" ]; then
    printf '[preview] would run: %s\n' "$*" >&2
    return 0
  fi
  "$@" >/dev/null
}

escape_json_string() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# --- Argument parsing -----------------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain)
        DOMAIN="${2:-}"
        shift 2
        ;;
      --email)
        EMAIL="${2:-}"
        shift 2
        ;;
      --repo)
        REPO="${2:-}"
        shift 2
        ;;
      --ref)
        REF="${2:-}"
        shift 2
        ;;
      --data-dir)
        DATA_DIR="${2:-}"
        shift 2
        ;;
      --apply)
        EXPLICIT_APPLY=true
        shift
        ;;
      --preview)
        EXPLICIT_PREVIEW=true
        shift
        ;;
      --help | -h)
        SHOW_HELP=true
        shift
        ;;
      *)
        printf 'unknown argument: %s\n' "$1" >&2
        exit 1
        ;;
    esac
  done
}

print_help() {
  cat >&2 <<EOF
Veduta installer

Usage:
  curl -fsSL $INSTALL_URL | sudo bash
  sudo bash deploy/install.sh [options]

Options:
  --domain <domain>   Public domain (A/AAAA record pointing at this VPS)
  --email <email>     ACME contact email
  --repo <git url>    Repository to clone (default: $DEFAULT_REPO)
  --ref <tag|sha>     Git ref to check out (default: main, resolved to a commit SHA)
  --data-dir <path>   Daemon data directory (default: $DEFAULT_DATA_DIR)
  --apply             Run unattended (requires --domain and --email when no tty is attached)
  --preview           Force preview mode: print the stage plan, make no changes, exit 0
  --help              Show this help

Modes:
  Interactive  -- a controlling tty is attached: prompts for any missing --domain/--email.
  Unattended   -- --apply --domain <d> --email <e>, no tty needed: fully automated.
  Preview      -- no tty and no --apply (or explicit --preview): prints the full stage plan
                  on stdout and a human summary on stderr, then exits 0 having made no changes.

Stage protocol (stdout only, one JSON line per stage transition):
  {"protocol_version":1,"stages":[{"id","title","status"},...],"needs_user_input":bool}
  Schema: InstallerStageEventSchema in @veduta/protocol. Every human-readable message is
  written to stderr instead.

Reruns: with an existing /opt/veduta checkout and no explicit --ref, the installer reuses the
currently checked-out commit instead of re-resolving 'main' -- pass --ref main to upgrade.
EOF
}

# --- --data-dir validation ---------------------------------------------------------------
# Runs unconditionally (both preview and apply) since it is a pure validation, not a mutation.

# Allowlist of parents a --data-dir may live under (issue #19 fix). A DENYLIST of exact
# system roots previously guarded this (rejecting only "/", "/etc", "/usr", ... verbatim) --
# that let plenty of dangerous paths through unrejected, e.g. "/usr/bin" (not an exact match
# in the old list, but `install -d -o veduta -g veduta -m 0700 /usr/bin` in user_layout_stage
# would still have bricked the system). An allowlist closes that off entirely: only paths
# strictly *under* one of these (not the parent itself -- at least one component below it).
readonly DATA_DIR_ALLOWED_PARENTS="/var/lib /srv /opt /var/local"

validate_data_dir() {
  case "$DATA_DIR" in
    /*) ;;
    *)
      printf 'error: --data-dir must be an absolute path (got: %s)\n' "$DATA_DIR" >&2
      exit 1
      ;;
  esac

  # Canonicalize lexically -- collapse "." and repeated slashes, reject "..". The directory
  # may not exist yet (this runs before user-layout would create it), so a real
  # realpath/`cd`-based resolution isn't available; a textual pass is enough to catch
  # traversal before the allowlist check below.
  local part canon=""
  local -a parts=()
  local IFS='/'
  for part in $DATA_DIR; do
    case "$part" in
      '' | '.') continue ;;
      '..')
        printf 'error: --data-dir must not contain ".." components (got: %s)\n' "$DATA_DIR" >&2
        exit 1
        ;;
      *) parts+=("$part") ;;
    esac
  done
  unset IFS

  for part in "${parts[@]}"; do
    canon="$canon/$part"
  done

  local parent allowed=false
  for parent in $DATA_DIR_ALLOWED_PARENTS; do
    case "$canon" in
      "$parent"/*) allowed=true ;;
    esac
  done
  if [ "$allowed" != "true" ]; then
    printf 'error: --data-dir must be strictly under one of: %s (got: %s)\n' \
      "$DATA_DIR_ALLOWED_PARENTS" "$canon" >&2
    exit 1
  fi

  DATA_DIR="$canon"
}

# --- Recovery command (used by every "how do I retry" hint) -------------------------------

compute_rerun_cmd() {
  # $0 is literally "bash" under `curl | sudo bash`, so a hint like `sudo bash $0` would
  # render as the nonsensical `sudo bash bash`. Prefer the actual script path when $0 names a
  # real, readable file (a local checkout); otherwise fall back to the canonical curl-pipe
  # invocation. Either way, carry forward whatever flags this run was actually given.
  local flags=""
  if [ "$REPO" != "$DEFAULT_REPO" ]; then
    flags="$flags --repo $REPO"
  fi
  if [ -n "$REF" ]; then
    flags="$flags --ref $REF"
  fi
  if [ "$DATA_DIR" != "$DEFAULT_DATA_DIR" ]; then
    flags="$flags --data-dir $DATA_DIR"
  fi
  if [ -n "$DOMAIN" ]; then
    flags="$flags --domain $DOMAIN"
  fi
  if [ -n "$EMAIL" ]; then
    flags="$flags --email $EMAIL"
  fi
  if [ "$EXPLICIT_APPLY" = "true" ]; then
    flags="$flags --apply"
  fi

  if [ -n "${0:-}" ] && [ -f "$0" ] && [ -r "$0" ]; then
    printf 'sudo bash %s%s' "$0" "$flags"
  else
    printf 'curl -fsSL %s | sudo bash -s --%s' "$INSTALL_URL" "$flags"
  fi
}

# --- Mode determination ---------------------------------------------------------------------

has_tty() {
  (exec 3</dev/tty) 2>/dev/null
}

determine_mode() {
  if [ "$EXPLICIT_PREVIEW" = "true" ]; then
    PREVIEW_MODE=true
    return 0
  fi

  if has_tty; then
    PREVIEW_MODE=false
    return 0
  fi

  if [ "$EXPLICIT_APPLY" = "true" ]; then
    if [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
      PREVIEW_MODE=false
      return 0
    fi
    printf 'error: --apply without a controlling tty requires --domain and --email\n' >&2
    exit 1
  fi

  PREVIEW_MODE=true
}

# --- Preview mode: a fully separate, read-only code path (see the header comment) -----------

preview_node_version_note() {
  local dir version
  dir=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd) || true
  if [ -n "$dir" ] && [ -f "$dir/.node-version" ]; then
    version=$(tr -d '[:space:]' <"$dir/.node-version")
    printf "%s (read from this checkout's .node-version)" "$version"
  else
    printf "pinned by the checked-out repository's .node-version (read after checkout)"
  fi
}

preview_pnpm_version_note() {
  local dir version
  dir=$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." 2>/dev/null && pwd) || true
  if [ -n "$dir" ] && [ -f "$dir/package.json" ]; then
    version=$(grep -o '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[^"]*"' "$dir/package.json" |
      sed -E 's/.*pnpm@([^"]+)".*/\1/') || true
    if [ -n "$version" ]; then
      printf "%s (read from this checkout's package.json packageManager field)" "$version"
      return 0
    fi
  fi
  printf "pinned by the checked-out repository's package.json packageManager field"
}

print_preview_summary() {
  cat >&2 <<'EOF'
Veduta installer -- PREVIEW MODE (no changes made)

No controlling tty was found and --apply was not given (or --preview was passed explicitly),
so this run is preview-only: nothing is written, downloaded, or installed. Below is exactly
what an apply run would do -- run this again from an interactive terminal (curl | sudo bash
while logged in over SSH), or with `--apply --domain <domain> --email <email>` for an
unattended run.
EOF
  printf '\n' >&2
  printf '  user/group:      veduta:veduta (system account, no login shell)\n' >&2
  printf '  code checkout:   %s -> /opt/veduta (root:root 0755)\n' "$REPO" >&2
  printf '  ref:             %s\n' "${REF:-main (resolved to a commit SHA, or the pinned existing checkout on a rerun)}" >&2
  printf '  data directory:  %s (veduta:veduta 0700)\n' "$DATA_DIR" >&2
  printf '  vault keyfile:   /etc/veduta/vault.key (created only if absent, never rotated)\n' >&2
  printf '  systemd unit:    /etc/systemd/system/veduta.service + veduta.service.d/{override,bootstrap}.conf\n' >&2
  printf '  node version:    %s\n' "$(preview_node_version_note)" >&2
  printf '  pnpm version:    %s\n' "$(preview_pnpm_version_note)" >&2
  printf '\n' >&2
  printf 'flags: --domain --email --repo --ref --data-dir --apply --preview --help\n' >&2
  printf 'stage protocol: one JSON line per stage transition on stdout (schema: @veduta/protocol InstallerStageEventSchema)\n' >&2
}

run_preview() {
  print_preview_summary
  emit_event true
}

# --- Interactive prompting (reads /dev/tty, never stdin -- curl | sudo bash consumes stdin
# as the script source, so stdin cannot double as a prompt channel) --------------------------

prompt_tty() {
  local label="$1" default="${2:-}" answer
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$label" "$default" >/dev/tty
  else
    printf '%s: ' "$label" >/dev/tty
  fi
  IFS= read -r answer </dev/tty
  if [ -z "$answer" ]; then
    printf '%s' "$default"
  else
    printf '%s' "$answer"
  fi
}

# --- Stage implementations ------------------------------------------------------------------

preflight_stage() {
  if [ "$(id -u)" -ne 0 ]; then
    printf 'error: this installer must run as root.\n' >&2
    printf 'rerun with:\n  %s\n' "$RERUN_CMD" >&2
    fail_stage 1
  fi

  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [ "${ID:-}" != "ubuntu" ]; then
      if printf '%s' "${ID_LIKE:-}" | grep -q debian; then
        printf 'warning: detected %s (debian-like) -- tested on Ubuntu 22.04/24.04, continuing\n' "${PRETTY_NAME:-$ID}" >&2
      else
        printf 'warning: detected %s -- tested on Ubuntu 22.04/24.04, continuing best-effort\n' "${PRETTY_NAME:-unknown}" >&2
      fi
    fi
  else
    printf 'warning: /etc/os-release not found, cannot verify distro -- continuing\n' >&2
  fi

  if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
    printf 'error: systemd is required (no systemctl, or /run/systemd/system missing)\n' >&2
    fail_stage 1
  fi

  # The invoking admin's home, captured before any escalation side effect (legacy-detect
  # needs it, and the daemon -- which runs as `veduta` under ProtectHome=yes -- never can).
  # ADMIN_HOME_KNOWN distinguishes "we know exactly whose home this is" (SUDO_USER resolved)
  # from "no idea, fell back to /root" -- legacy-detect scans more broadly in the latter case.
  if [ -n "${SUDO_USER:-}" ] && getent passwd "$SUDO_USER" >/dev/null 2>&1; then
    ADMIN_HOME=$(getent passwd "$SUDO_USER" | cut -d: -f6)
    ADMIN_HOME_KNOWN=true
  else
    ADMIN_HOME="/root"
    ADMIN_HOME_KNOWN=false
  fi

  # Domain/email are collected here, in preflight, rather than in the systemd-unit stage --
  # asking up front means the operator isn't babysitting the multi-minute deps/build phase
  # just to answer a prompt that could have been asked before any of it started. An existing
  # override.conf's values (a rerun against an already-configured host) become the prompt
  # defaults, parsed before prompting.
  local override_conf=/etc/systemd/system/veduta.service.d/override.conf
  local current_domain="" current_email=""
  if [ -f "$override_conf" ]; then
    current_domain=$(grep -o 'VEDUTA_PUBLIC_DOMAIN=[^[:space:]]*' "$override_conf" | head -n1 | cut -d= -f2- || true)
    current_email=$(grep -o 'VEDUTA_ACME_EMAIL=[^[:space:]]*' "$override_conf" | head -n1 | cut -d= -f2- || true)
  fi
  if [ -z "$DOMAIN" ]; then
    DOMAIN=$(prompt_tty "Public domain (A/AAAA record pointing at this VPS)" "$current_domain")
  fi
  if [ -z "$EMAIL" ]; then
    EMAIL=$(prompt_tty "ACME contact email" "$current_email")
  fi
  if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
    printf 'error: a domain and an email are required (via --domain/--email or the prompts above)\n' >&2
    fail_stage 1
  fi
}

# True (exit 0) when $1 exists and is NOT itself a symlink (B10, security review): the guard
# every legacy source-root/source-directory check in this section applies before its `-e`/`-d`
# test. This root-run installer must never follow a symlinked source root or subdirectory (a
# planted `~/.hermes/memories -> /root/...`, or `~/.openclaw` itself replaced by a symlink) into
# staging or detecting files from outside the legacy install it thinks it is reading.
not_symlink() {
  [ ! -L "$1" ]
}

# Echoes the first of $home/.openclaw, $home/.clawdbot, $home/.moltbot that exists AND is not
# itself a symlink (OpenClaw's former names, docs/references/04-onboarding-migration.md §B;
# B10 symlink guard), or nothing and exits non-zero if none qualify. Shared by
# legacy_detect_stage (which only needs a yes/no) and stage_legacy_memory (T9, which needs the
# actual directory to copy from).
resolve_openclaw_home() {
  local home="$1" alias candidate
  for alias in $OPENCLAW_HOME_ALIASES; do
    candidate="$home/$alias"
    if not_symlink "$candidate" && [ -e "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# True (exit 0) when $1/.hermes exists and is not a symlink (B10 symlink guard).
hermes_root_present() {
  not_symlink "$1/.hermes" && [ -e "$1/.hermes" ]
}

legacy_detect_stage() {
  LEGACY_OPENCLAW=false
  LEGACY_HERMES=false
  local candidates home found_home=""

  if [ "$ADMIN_HOME_KNOWN" = "true" ]; then
    candidates="$ADMIN_HOME"
  else
    # No resolvable SUDO_USER means the installer is running as root directly (no sudo
    # wrapper), so there is no single unambiguous admin home -- scan /root and every per-user
    # home under /home, first hit wins.
    candidates="/root"
    if [ -d /home ]; then
      for home in /home/*/; do
        [ -d "$home" ] || continue
        candidates="$candidates ${home%/}"
      done
    fi
  fi

  for home in $candidates; do
    if resolve_openclaw_home "$home" >/dev/null || hermes_root_present "$home"; then
      found_home="$home"
      if resolve_openclaw_home "$home" >/dev/null; then
        LEGACY_OPENCLAW=true
      fi
      if hermes_root_present "$home"; then
        LEGACY_HERMES=true
      fi
      break
    fi
  done

  if [ -n "$found_home" ]; then
    ADMIN_HOME="$found_home"
    printf 'legacy agent install detected under %s -- the onboarding wizard will offer migration before manual configuration (issue 019 AC3)\n' "$ADMIN_HOME" >&2
  fi
}

# Persists the legacy-detect result into the onboarding.json seed. Called from
# user_layout_stage, once DATA_DIR (owned by veduta:veduta) exists -- see tasks/plan.md
# decision 10: "held in memory until the layout stage exists, then persisted atomically".
persist_legacy_seed() {
  local seed_path="$DATA_DIR/onboarding.json" legacy_json content tmp
  if [ -e "$seed_path" ]; then
    printf 'onboarding.json already exists at %s -- leaving existing wizard state untouched\n' "$seed_path" >&2
    return 0
  fi
  legacy_json=$(printf '{"openclaw":%s,"hermes":%s' "$LEGACY_OPENCLAW" "$LEGACY_HERMES")
  if [ -n "$ADMIN_HOME" ]; then
    legacy_json="$legacy_json,\"sourceHome\":\"$(escape_json_string "$ADMIN_HOME")\""
  fi
  legacy_json="$legacy_json}"
  content="{\"version\":1,\"steps\":{},\"legacy\":$legacy_json}"
  tmp="$seed_path.tmp.$$"
  printf '%s' "$content" | run_quiet tee "$tmp"
  # Harden the file (ownership, mode, and an fsync) BEFORE the rename, so there is never a
  # window where a root-owned, world-readable onboarding.json is visible under its final name.
  run chown veduta:veduta "$tmp"
  run chmod 0600 "$tmp"
  run sync "$tmp"
  run mv "$tmp" "$seed_path"
  printf 'seeded %s with the legacy detection result\n' "$seed_path" >&2
}

# --- Legacy memory staging (tasks/plan.md decision 16) ------------------------------------
#
# The daemon runs as `veduta` under ProtectHome=yes (deploy/veduta.service) and can therefore
# NEVER read /home/<admin>/.hermes or /home/<admin>/.openclaw -- the same constraint that
# already pushed legacy *detection* (above) into this installer. Without staging, the
# onboarding wizard's migration step could never actually import anything on a real VPS
# profile. So, once $DATA_DIR exists and is owned veduta:veduta (persist_legacy_seed already
# ran), this installer -- which runs as root and can read both sides -- copies ONLY the
# memory-and-identity files into a flat layout under $DATA_DIR/import-source/<kind>/, matching
# the flat fallback packages/daemon/src/import-source.ts's readLegacySource already reads:
# SOUL.md, USER.md, MEMORY.md, and a notes/ directory of .md files. Nothing else is ever
# staged -- no .env, auth.json, openclaw.json, state.db, sessions/, logs/, skills/, cron/,
# pending/, or anything unrecognised -- which is what makes the wizard's import path
# secret-free by construction; importing a secret stays a CLI-only operation (--secrets flag,
# issue 020). The source install itself is never modified.

# Copies a single file from $1 to $2, refusing anything that is not a plain regular file
# (never a symlink -- a symlinked SOUL.md in the source must never be dereferenced into the
# daemon's data dir) and anything over the 1 MiB cap the daemon-side reader also enforces
# (import-source.ts's MAX_FILE_BYTES). Uses a plain `cp` of one named file, never `cp -a`/`-r`
# of a whole tree. Does nothing (not even a log line) when $1 simply does not exist -- every
# one of these files is optional in the vendor layout.
stage_legacy_file() {
  local src="$1" dest="$2"
  if [ -L "$src" ]; then
    printf 'refusing to stage %s -- it is a symlink, not a regular file\n' "$src" >&2
    return 0
  fi
  if [ ! -f "$src" ]; then
    return 0
  fi
  if [ -n "$(find "$src" -size +1M 2>/dev/null)" ]; then
    printf 'refusing to stage %s -- larger than the 1 MiB cap\n' "$src" >&2
    return 0
  fi
  run cp "$src" "$dest"
  run chown veduta:veduta "$dest"
  run chmod 0600 "$dest"
}

# Copies the flat .md notes directly under $1 into $2 (already created, veduta:veduta 0700),
# applying stage_legacy_file's same per-file checks -- so a symlinked or oversized note is
# refused exactly like a symlinked or oversized SOUL/USER/MEMORY. $3 is a space-separated list
# of basenames to skip (Hermes keeps USER.md/MEMORY.md inside the same memories/ directory as
# the notes; OpenClaw's workspace/memory/ has no such overlap, so it passes an empty list).
stage_legacy_notes() {
  local src_dir="$1" dest_dir="$2" exclude="$3" src_file name skip excluded
  for src_file in "$src_dir"/*.md; do
    [ -e "$src_file" ] || continue
    name=$(basename "$src_file")
    excluded=false
    for skip in $exclude; do
      if [ "$name" = "$skip" ]; then
        excluded=true
      fi
    done
    if [ "$excluded" = "true" ]; then
      continue
    fi
    stage_legacy_file "$src_file" "$dest_dir/$name"
  done
}

# Stages one detected kind (openclaw|hermes) from $2 (the vendor-layout source directory --
# already resolved to whichever alias matched) into $DATA_DIR/import-source/$1. Idempotent: an
# already-existing destination directory is left completely untouched on a rerun, same shape
# as persist_legacy_seed's existing-file message. Does nothing if $2 was not resolved (should
# not happen when the corresponding LEGACY_* flag is true, but this function never assumes).
#
# B10: refuses a symlinked source root outright, and a symlinked workspace/memories
# subdirectory (the one nested directory each vendor layout reads files out of) -- staging
# individual files through a symlinked *intermediate* directory component would let a planted
# symlink (e.g. `~/.hermes/memories -> /root/somewhere-else`) smuggle files from outside the
# legacy install past stage_legacy_file's own guard, which only ever checks the final path
# component.
#
# B11: stages into a sibling temporary directory ($staging_dir) and atomically `mv`s it into
# $dest_dir only once every file has been copied, rather than creating $dest_dir itself up
# front and copying into it in place. A crash or kill mid-copy previously left a permanently
# partial $dest_dir that this function's own "already exists" rerun check would treat as
# complete forever; now only the final, renamed-into-place $dest_dir ever counts as done.
stage_one_legacy_kind() {
  local kind="$1" src_dir="$2" dest_dir staging_dir
  local soul_src user_src memory_src notes_src_dir notes_exclude
  if [ -z "$src_dir" ] || [ -L "$src_dir" ] || [ ! -d "$src_dir" ]; then
    return 0
  fi

  dest_dir="$DATA_DIR/import-source/$kind"
  if [ -e "$dest_dir" ]; then
    printf '%s already exists -- leaving existing staged copy untouched\n' "$dest_dir" >&2
    return 0
  fi

  case "$kind" in
    hermes)
      if [ -L "$src_dir/memories" ]; then
        printf 'refusing to stage from %s -- memories is a symlink, not a directory\n' "$src_dir" >&2
        return 0
      fi
      soul_src="$src_dir/SOUL.md"
      user_src="$src_dir/memories/USER.md"
      memory_src="$src_dir/memories/MEMORY.md"
      notes_src_dir="$src_dir/memories"
      notes_exclude="USER.md MEMORY.md"
      ;;
    openclaw)
      if [ -L "$src_dir/workspace" ]; then
        printf 'refusing to stage from %s -- workspace is a symlink, not a directory\n' "$src_dir" >&2
        return 0
      fi
      soul_src="$src_dir/workspace/SOUL.md"
      user_src="$src_dir/workspace/USER.md"
      memory_src="$src_dir/workspace/MEMORY.md"
      notes_src_dir="$src_dir/workspace/memory"
      notes_exclude=""
      ;;
    *)
      return 0
      ;;
  esac

  staging_dir="$DATA_DIR/import-source/.${kind}.staging.$$"
  run rm -rf "$staging_dir"
  run install -d -o veduta -g veduta -m 0700 "$staging_dir"
  stage_legacy_file "$soul_src" "$staging_dir/SOUL.md"
  stage_legacy_file "$user_src" "$staging_dir/USER.md"
  stage_legacy_file "$memory_src" "$staging_dir/MEMORY.md"

  if [ -d "$notes_src_dir" ] && [ ! -L "$notes_src_dir" ]; then
    run install -d -o veduta -g veduta -m 0700 "$staging_dir/notes"
    stage_legacy_notes "$notes_src_dir" "$staging_dir/notes" "$notes_exclude"
  fi

  run mv "$staging_dir" "$dest_dir"

  printf 'staged legacy %s memory files from %s into %s (veduta:veduta, secrets never staged)\n' \
    "$kind" "$src_dir" "$dest_dir" >&2
}

# Called from user_layout_stage, right after persist_legacy_seed (i.e. once $DATA_DIR exists
# and is owned veduta:veduta). Does nothing when legacy_detect_stage found nothing.
stage_legacy_memory() {
  if [ "$LEGACY_OPENCLAW" = "true" ]; then
    stage_one_legacy_kind openclaw "$(resolve_openclaw_home "$ADMIN_HOME" || true)"
  fi
  if [ "$LEGACY_HERMES" = "true" ]; then
    stage_one_legacy_kind hermes "$ADMIN_HOME/.hermes"
  fi
}

deps_stage() {
  run apt-get update
  run apt-get install -y git curl ca-certificates qrencode xz-utils
}

user_layout_stage() {
  # Exactly deploy/README.md §1, made idempotent for reruns.
  if ! getent group veduta >/dev/null 2>&1; then
    run groupadd --system veduta
  fi
  if ! getent passwd veduta >/dev/null 2>&1; then
    run useradd --system --gid veduta --home /var/lib/veduta --shell /usr/sbin/nologin veduta
  fi
  run install -d -o root -g root -m 0755 /opt/veduta
  run install -d -o veduta -g veduta -m 0700 /var/lib/veduta
  run install -d -o veduta -g veduta -m 0700 "$DATA_DIR"
  run install -d -o root -g root -m 0755 /etc/veduta

  persist_legacy_seed
  stage_legacy_memory
}

checkout_stage() {
  local ref="${REF:-main}"
  if [ -d /opt/veduta/.git ]; then
    # Honor a changed --repo on a rerun -- otherwise the fetch below silently keeps talking
    # to whatever origin the very first install pointed at.
    run git -C /opt/veduta remote set-url origin "$REPO"
    run git -C /opt/veduta clean -fdx

    if [ -z "$REF" ]; then
      # A rerun with no explicit --ref pins to whatever commit is already checked out.
      # `main` moves; a recovery rerun (retrying a failed later stage) must not silently
      # advance the code out from under the operator. Pass --ref explicitly to upgrade.
      RESOLVED_SHA=$(git -C /opt/veduta rev-parse HEAD)
      printf 'existing checkout found and no --ref given -- pinning to the current commit %s (pass --ref to upgrade)\n' "$RESOLVED_SHA" >&2
      run git -C /opt/veduta reset --hard "$RESOLVED_SHA"
      return 0
    fi
  else
    run git clone --no-checkout "$REPO" /opt/veduta
  fi

  run git -C /opt/veduta fetch origin "$ref"
  RESOLVED_SHA=$(git -C /opt/veduta rev-parse FETCH_HEAD)
  run git -C /opt/veduta reset --hard "$RESOLVED_SHA"
  printf 'checked out %s @ %s -> commit %s\n' "$REPO" "$ref" "$RESOLVED_SHA" >&2
}

detect_node_arch() {
  local machine
  machine=$(uname -m)
  case "$machine" in
    x86_64) printf 'x64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *)
      printf 'error: unsupported architecture %s\n' "$machine" >&2
      fail_stage 1
      ;;
  esac
}

# Downloads the exact Node build pinned by .node-version, verifies it against nodejs.org's
# published SHASUMS256.txt, and installs it into /usr/local (the supply-chain trust root: TLS
# to nodejs.org plus a SHA256 check, not a full signature chain -- see the header comment).
install_node() {
  local version="$1" arch base dist tmp_dir
  arch=$(detect_node_arch)
  base="node-v${version}-linux-${arch}"
  dist="https://nodejs.org/dist/v${version}"
  tmp_dir=$(mktemp -d)
  run curl -fsSL -o "$tmp_dir/$base.tar.xz" "$dist/$base.tar.xz"
  run curl -fsSL -o "$tmp_dir/SHASUMS256.txt" "$dist/SHASUMS256.txt"
  # sha256sum -c prints an "OK" line to its own stdout -- not a mutation, so not routed
  # through run(), but still redirected explicitly so it never reaches the protocol stream.
  (cd "$tmp_dir" && grep " ${base}.tar.xz\$" SHASUMS256.txt | sha256sum -c -) 1>&2
  run tar -xJf "$tmp_dir/$base.tar.xz" -C /usr/local --strip-components=1
  run rm -rf "$tmp_dir"
  printf 'installed node v%s (%s) into /usr/local\n' "$version" "$arch" >&2
}

build_stage() {
  local node_version pnpm_version tsx_bin
  node_version=$(tr -d '[:space:]' </opt/veduta/.node-version)
  pnpm_version=$(grep -o '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[^"]*"' /opt/veduta/package.json |
    sed -E 's/.*pnpm@([^"]+)".*/\1/')

  install_node "$node_version"
  run corepack enable
  run corepack prepare "pnpm@$pnpm_version" --activate

  (cd /opt/veduta && run pnpm install --frozen-lockfile)
  (cd /opt/veduta && run pnpm build)

  # tsx is a devDependency of @veduta/daemon (not of the workspace root), so pnpm's hoisting
  # puts its bin at packages/daemon/node_modules/.bin/tsx, NOT the top-level node_modules/.bin
  # -- the systemd-unit stage's ExecStart depends on this exact path. Fail loudly here, before
  # systemctl ever gets a unit that would just crash-loop.
  tsx_bin=/opt/veduta/packages/daemon/node_modules/.bin/tsx
  if [ ! -x "$tsx_bin" ]; then
    printf 'error: tsx binary not found at %s after build -- check that @veduta/daemon devDependencies installed correctly\n' "$tsx_bin" >&2
    fail_stage 1
  fi
}

vault_keyfile_stage() {
  # deploy/README.md §2. Create-if-absent only: rotating an existing keyfile would make the
  # vault it decrypts undecryptable, so an existing file is never touched.
  local keyfile=/etc/veduta/vault.key
  if [ -e "$keyfile" ]; then
    printf 'vault keyfile already exists at %s -- leaving it untouched\n' "$keyfile" >&2
    return 0
  fi
  head -c 48 /dev/urandom | base64 | run_quiet tee "$keyfile"
  run chown veduta:veduta "$keyfile"
  run chmod 0400 "$keyfile"
  printf 'generated vault keyfile at %s -- back it up out-of-band (e.g. a password manager); it is never included in encrypted backups by design\n' "$keyfile" >&2
}

systemd_unit_stage() {
  local unit_dst=/etc/systemd/system/veduta.service
  local dropin_dir=/etc/systemd/system/veduta.service.d
  local override_conf="$dropin_dir/override.conf"
  local bootstrap_conf="$dropin_dir/bootstrap.conf"
  local ts
  ts=$(date -u +%Y%m%dT%H%M%SZ)

  if [ -f "$unit_dst" ]; then
    run cp "$unit_dst" "$unit_dst.bak-$ts"
  fi
  run cp /opt/veduta/deploy/veduta.service "$unit_dst"

  run install -d -o root -g root -m 0755 "$dropin_dir"

  if [ -f "$override_conf" ]; then
    run cp "$override_conf" "$override_conf.bak-$ts"
  fi
  {
    printf '[Service]\n'
    printf 'Environment=VEDUTA_PUBLIC_DOMAIN=%s\n' "$DOMAIN"
    printf 'Environment=VEDUTA_ACME_EMAIL=%s\n' "$EMAIL"
    if [ "$DATA_DIR" != "$DEFAULT_DATA_DIR" ]; then
      # A non-default data dir needs its own Environment override AND a ReadWritePaths grant
      # -- ProtectSystem=strict in veduta.service otherwise blocks writes outside the
      # directories the base unit already allows, so the daemon would silently fail to read
      # or write onboarding.json/installer-stages.json seeded by this installer.
      printf 'Environment=VEDUTA_DATA_DIR=%s\n' "$DATA_DIR"
      printf 'ReadWritePaths=%s\n' "$(dirname "$DATA_DIR")"
    fi
    printf 'Restart=always\n'
    printf 'ExecStart=\n'
    printf 'ExecStart=/usr/local/bin/node /opt/veduta/packages/daemon/node_modules/.bin/tsx /opt/veduta/packages/daemon/src/index.ts\n'
  } | run_quiet tee "$override_conf"
  run chmod 0644 "$override_conf"

  # The bootstrap code is generated FRESH on every apply run (issue #19 fix) and injected via
  # its own root-only drop-in, kept separate from override.conf so the domain/email drop-in
  # never carries a secret. Earlier revisions of this installer reused an existing
  # bootstrap.conf code across reruns -- but a code that expired unconsumed between runs would
  # then get its hash re-seeded by AuthStore on restart, reviving a dead code and printing a
  # QR for it below (or, if AuthStore itself refused to revive it, printing a QR for a code
  # that would never actually work). There is no reachable point in this script (before
  # first-boot) where /api/auth/status could be polled to check whether pairing is even still
  # required, so this stage cannot skip regenerating just because a passkey might already be
  # registered -- instead, a fresh code is generated unconditionally, and it is always
  # harmless: if a passkey IS already registered, the daemon's AuthStore ignores
  # VEDUTA_BOOTSTRAP_CODE entirely (see packages/daemon/src/auth-store.ts), and pairing_stage
  # below prints no QR in that case anyway. A fresh code is also always unseen by the
  # daemon's seen-bootstrap-code-hash log, so it always seeds and the QR this run prints is
  # always valid.
  BOOTSTRAP_CODE=$(head -c 9 /dev/urandom | base64 | tr '+/' '-_' | cut -c1-12)
  printf '[Service]\nEnvironment=VEDUTA_BOOTSTRAP_CODE=%s\n' "$BOOTSTRAP_CODE" | run_quiet tee "$bootstrap_conf"
  run chmod 0600 "$bootstrap_conf"
  run chown root:root "$bootstrap_conf"

  run systemctl daemon-reload
}

first_boot_stage() {
  run systemctl enable veduta
  # `restart` (not `enable --now`) so a rerun against an already-running service also picks
  # up a regenerated bootstrap.conf / changed override.conf, not just a fresh install.
  run systemctl restart veduta

  local tries=0
  while [ "$tries" -lt 30 ]; do
    if systemctl is-active --quiet veduta; then
      break
    fi
    tries=$((tries + 1))
    sleep 2
  done
  if ! systemctl is-active --quiet veduta; then
    printf 'error: veduta.service did not become active\n' >&2
    fail_stage 1
  fi

  # /api/health is auth-protected on the VPS profile and plain localhost HTTP gets a 308
  # redirect (ACME challenge server), so the public, unauthenticated /api/auth/status is the
  # only endpoint that can be polled here. ACME issuance can take a while, hence the long wait.
  local waited=0 max_wait=180 ready=false
  while [ "$waited" -lt "$max_wait" ]; do
    if curl -fsk --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/auth/status" >/dev/null 2>&1; then
      ready=true
      break
    fi
    sleep 5
    waited=$((waited + 5))
  done
  if [ "$ready" != "true" ]; then
    printf 'error: timed out waiting for https://%s/api/auth/status (ACME issuance can take a few minutes)\n' "$DOMAIN" >&2
    fail_stage 1
  fi
}

pairing_stage() {
  local url="https://${DOMAIN}/setup?code=${BOOTSTRAP_CODE}"

  # If a passkey is already registered (a rerun after pairing already completed), there is
  # nothing left to pair -- note it on stderr, mark this stage `skipped` in the protocol, and
  # print no QR/URL (a stale-but-still-valid-looking code would be misleading).
  local status_body
  status_body=$(curl -fsk --resolve "${DOMAIN}:443:127.0.0.1" "https://${DOMAIN}/api/auth/status" 2>/dev/null || true)
  if printf '%s' "$status_body" | grep -q '"passkeyRegistered":true'; then
    printf 'a passkey is already registered for %s -- pairing is already done, skipping the QR code\n' "$DOMAIN" >&2
    set_stage_status pairing skipped
    return 0
  fi

  printf '\nsetup URL (the code expires in 60 minutes):\n  %s\n\n' "$url" >&2
  if command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 "$url" >&2
  else
    printf '(qrencode not found -- install it for a scannable QR code: sudo apt-get install -y qrencode)\n' >&2
  fi
  printf '\nif the code expires before you pair:\n  sudo systemctl restart veduta\n  sudo journalctl -u veduta | grep first-boot\n' >&2
}

# --- Failure handling -----------------------------------------------------------------------

print_recovery_hint() {
  local stage="$1"
  printf '\ninstaller failed at stage: %s\n' "${stage:-unknown}" >&2
  case "$stage" in
    preflight | legacy-detect | user-layout | checkout | build | vault-keyfile | systemd-unit)
      printf 'every stage above is idempotent -- fix the issue reported above, then rerun:\n  %s\n' "$RERUN_CMD" >&2
      ;;
    deps)
      printf 'check network/apt access, then rerun:\n  sudo apt-get update\n  %s\n' "$RERUN_CMD" >&2
      ;;
    first-boot)
      printf 'inspect the logs, then rerun:\n  sudo journalctl -u veduta -n 50\n  %s\n' "$RERUN_CMD" >&2
      ;;
    pairing)
      printf 'the service is already up -- rerun to reprint the QR code:\n  %s\n' "$RERUN_CMD" >&2
      ;;
    *)
      printf 'rerun:\n  %s\n' "$RERUN_CMD" >&2
      ;;
  esac
}

# Shared by every failure path (the ERR trap, INT/TERM handlers, and fail_stage): mark the
# current stage failed, emit the failure event, print the recovery hint, and best-effort
# persist the final stage snapshot.
emit_failure_event() {
  if [ -n "$CURRENT_STAGE" ]; then
    set_stage_status "$CURRENT_STAGE" "failed"
  fi
  emit_event false
  print_recovery_hint "$CURRENT_STAGE"
  write_stage_file false 2>/dev/null || true
}

# Every explicit failure path inside a stage (an explicit `exit`, as opposed to a command that
# merely returns non-zero) must go through here: bash's `exit` builtin does not itself trigger
# the ERR trap (confirmed empirically -- `set -Eeuo pipefail` re-arms ERR across functions and
# subshells, but does not turn `exit` into a "failing command"), so on_error would otherwise
# never see these and the failed-stage event would never be emitted.
fail_stage() {
  trap - ERR INT TERM
  emit_failure_event
  exit "${1:-1}"
}

on_error() {
  local exit_code=$?
  trap - ERR INT TERM
  emit_failure_event
  exit "$exit_code"
}

on_interrupt() {
  trap - ERR INT TERM
  emit_failure_event
  exit 130
}

on_terminate() {
  trap - ERR INT TERM
  emit_failure_event
  exit 143
}

# --- Apply mode driver -----------------------------------------------------------------------

run_stage() {
  local id="$1" fn="$2"
  CURRENT_STAGE="$id"
  set_stage_status "$id" "running"
  emit_event false
  "$fn"
  if [ "$(stage_status "$id")" != "skipped" ]; then
    set_stage_status "$id" "done"
  fi
  emit_event false
}

run_apply() {
  trap on_error ERR
  trap on_interrupt INT
  trap on_terminate TERM

  run_stage preflight preflight_stage
  run_stage legacy-detect legacy_detect_stage
  run_stage deps deps_stage
  run_stage user-layout user_layout_stage
  run_stage checkout checkout_stage
  run_stage build build_stage
  run_stage vault-keyfile vault_keyfile_stage
  run_stage systemd-unit systemd_unit_stage
  run_stage first-boot first_boot_stage
  run_stage pairing pairing_stage

  write_stage_file false
  trap - ERR INT TERM

  printf '\nresolved commit: %s\n' "$RESOLVED_SHA" >&2
  printf 'done -- veduta is running at https://%s\n' "$DOMAIN" >&2
}

# --- Entry point -------------------------------------------------------------------------

main() {
  parse_args "$@"
  if [ "$SHOW_HELP" = "true" ]; then
    print_help
    exit 0
  fi
  validate_data_dir
  RERUN_CMD=$(compute_rerun_cmd)
  determine_mode
  if [ "$PREVIEW_MODE" = "true" ]; then
    run_preview
    exit 0
  fi
  run_apply
}

main "$@"
