#!/usr/bin/env bash
# Guided production installer (issues #19 and #48, ADR-0015).
# Download this file before invoking sudo: interactive pipes can lose their
# terminal under sudo-rs. Preview never calls a stage or mutates the host.
# Human progress goes to stderr; --json opts into the stage protocol on stdout.
# Bash 3.2 syntax is retained for read-only previews on macOS.

set -Eeuo pipefail

# --- Constants --------------------------------------------------------------------------

readonly INSTALL_URL="https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh"
readonly DEFAULT_REPO="https://github.com/Ic3b3rg/veduta.git"
readonly DEFAULT_DATA_DIR="/var/lib/veduta/.veduta"
# The signed self-update feed (issue #43, docs/adr/0013-signed-self-update.md and its
# "Amendments" section): upstream defaults so a fork gets its own update channel with zero
# source patches, by pinning its own --update-feed/--update-root-key at install time instead.
readonly DEFAULT_UPDATE_FEED="https://raw.githubusercontent.com/Ic3b3rg/veduta/main/feed/stable.json"
# Root-owned trust anchors, written only by write_update_pinning below. A single named constant
# (instead of the path repeated as a literal in write_update_pinning, systemd_unit_stage's
# override.conf, and print_update_pinning_notice) keeps those three call sites from drifting.
readonly UPDATE_PINNING_PATH=/etc/veduta/update.json

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
  "Register the first passkey"
)
STAGE_STATUS=(pending pending pending pending pending pending pending pending pending pending)

# --- Global state (set by parse_args / determine_mode / stage functions) -----------------

REPO="$DEFAULT_REPO"
REF=""
DOMAIN=""
EMAIL=""
DATA_DIR="$DEFAULT_DATA_DIR"
UPDATE_FEED="$DEFAULT_UPDATE_FEED"
UPDATE_ROOT_KEY=""
EXPLICIT_APPLY=false
EXPLICIT_PREVIEW=false
SKIP_CODEX=false
SHOW_HELP=false
PREVIEW_MODE=false
RERUN_CMD=""
ACCESS=""
ACCESS_PORT=""
SSH_TARGET=""
SSH_PORT=""
JSON_OUTPUT=false
SETUP_ONLY=false
MANAGE_ACCESS=false
EDIT_ACCESS=false
TAILNET_HTTPS_PORT=""
CURRENT_TAILNET_PORT=""
TAILSCALE_INSTALL_CONSENT=false
TAILNET_DEVICE_APPROVAL=false
TAILNET_CERTIFICATE_CONSENT=false
INSTALLER_STATE=planning
REPLY=""
ORIGIN=""
EXISTING_ACCESS=false
ACCESS_CHANGE=false
ACCESS_CONFIG=/etc/veduta/access.json
CURRENT_ACCESS=""
CURRENT_ORIGIN=""
CURRENT_PORT=""
SERVICE_NAME=veduta
INSTALL_LOG=""

ADMIN_HOME=""
ADMIN_HOME_KNOWN=false
LEGACY_OPENCLAW=false
LEGACY_HERMES=false
RESOLVED_SHA=""
BOOTSTRAP_CODE=""
CURRENT_STAGE=""

# OpenClaw's former names (docs/references/04-onboarding-migration.md §B: "Legacy name
# support (.clawdbot, .moltbot)"). Mirrors packages/daemon/src/import-source.ts's exported
# OPENCLAW_ALIASES (the TypeScript side used to keep this list twice --
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
  local needs="$1" repair="$RERUN_CMD"
  case "$CURRENT_STAGE" in first-boot|pairing) repair='sudo veduta setup' ;; esac
  if [ "$SETUP_ONLY" = true ]; then repair='sudo veduta setup'; fi
  printf '{"protocol_version":1,"stages":%s,"needs_user_input":%s,"access_mode":"%s","state":"%s","repair_command":"%s"}' \
    "$(stages_json_fragment)" "$needs" "${ACCESS:-tunnel}" "$INSTALLER_STATE" "$(escape_json_multiline "$repair")"
}

emit_event() {
  if [ "$JSON_OUTPUT" = true ] || [ "$PREVIEW_MODE" = true ]; then
    event_json "$1"
    printf '\n'
  fi
}

# `<dataDir>/installer-stages.json` -- the PWA onboarding wizard's installer summary.
# Silently skipped when DATA_DIR does not exist yet (an early
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
  if [ -z "$INSTALL_LOG" ]; then "$@" 1>&2; return; fi
  local code
  if "$@" >>"$INSTALL_LOG" 2>&1; then return 0; else code=$?; fi
  printf 'Command failed. Recent log output:\n' >&2
  tail -n 20 "$INSTALL_LOG" >&2
  printf 'Full log: sudo less %s\n' "$INSTALL_LOG" >&2
  return "$code"
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

# Same escaping as escape_json_string, plus folding any literal newline in $1 into a JSON \n
# escape -- a minisign public key file is two lines (docs/adr/0013-signed-self-update.md's
# "Amendments" section), and the expected calling convention for --update-root-key is
# `--update-root-key "$(cat veduta-root.pub)"`, which hands this function a real embedded
# newline that plain JSON string syntax cannot contain unescaped. The join is done with awk,
# not a GNU-sed-only `:a;N;$!ba` hold-space loop, so this also works under BSD sed (macOS).
escape_json_multiline() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'NR>1{printf "\\n"} {printf "%s", $0}'
}

# --- Argument parsing -----------------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --access|--port|--tailnet-port|--ssh-target|--ssh-port|--domain|--email|--repo|--ref|--data-dir|--update-feed|--update-root-key)
        if [ $# -lt 2 ] || [ -z "$2" ] || [[ "$2" = --* ]]; then
          printf 'error: %s requires a value\n' "$1" >&2; exit 64
        fi ;;
    esac
    case "$1" in
      --access) ACCESS="${2:-}"; shift 2 ;;
      --tailnet-port) TAILNET_HTTPS_PORT="${2:-}"; shift 2 ;;
      --install-tailscale) TAILSCALE_INSTALL_CONSENT=true; shift ;;
      --device-approval-confirmed) TAILNET_DEVICE_APPROVAL=true; shift ;;
      --accept-certificate-name) TAILNET_CERTIFICATE_CONSENT=true; shift ;;
      --port) ACCESS_PORT="${2:-}"; shift 2 ;;
      --ssh-target) SSH_TARGET="${2:-}"; shift 2 ;;
      --ssh-port) SSH_PORT="${2:-}"; shift 2 ;;
      --json) JSON_OUTPUT=true; shift ;;
      --setup) SETUP_ONLY=true; shift ;;
      --manage-access) MANAGE_ACCESS=true; shift ;;
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
      --update-feed)
        UPDATE_FEED="${2:-}"
        shift 2
        ;;
      --update-root-key)
        # Raw key text or `@/path/to/file` (resolved by resolve_update_root_key, called once
        # arg parsing is done -- so compute_rerun_cmd below still sees the short `@file` form
        # instead of embedding the (possibly multi-line) key text itself into a rerun hint).
        UPDATE_ROOT_KEY="${2:-}"
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
      --skip-codex)
        SKIP_CODEX=true
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

Download, then run on your VPS:
  curl -fsSLo veduta-install.sh $INSTALL_URL && sudo env SSH_CONNECTION="\$SSH_CONNECTION" bash veduta-install.sh

Options:
  --access tunnel|tailnet|public  Tailnet when connected; otherwise Tunnel
  --port <port>           Loopback port; also the Tunnel client port (default: 8788)
  --tailnet-port <port>   Private HTTPS port (default: 443, or installed value)
  --install-tailscale     Allow installation from Tailscale's official repository
  --device-approval-confirmed  Confirm Device approval is enabled in your account
  --accept-certificate-name    Accept the public HTTPS certificate hostname disclosure
  --ssh-target user@host  SSH destination for the computer handoff
  --ssh-port <port>       SSH server port (default: detected, or 22)
  --domain <domain>       Required for Public access
  --email <email>         Certificate contact for Public access
  --repo <url>            Source repository (default: $DEFAULT_REPO)
  --ref <tag|sha>         Pin a source ref (default: main on a fresh install)
  --data-dir <path>       Persistent data (default: $DEFAULT_DATA_DIR)
  --update-feed <url>     Signed update feed (default: $DEFAULT_UPDATE_FEED)
  --update-root-key <key|@file>
                         Explicit trust anchor; upstream fresh installs use docs/keys/root.pub
  --apply                Confirm the plan without prompts; provide all mode-specific values
  --preview              Show the plan without changing the host
  --json                 Emit stage events on stdout (preview always emits JSON)
  --skip-codex            Skip the optional ChatGPT subscription connection binary
  --help                 Show this help

Without a terminal or --apply, only a preview is produced.
After installation: sudo veduta setup (recover pairing); sudo veduta access (change access).
An access change requires a new passkey and restores the previous access on failure.
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
  if ! [[ "$DATA_DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
    printf 'error: --data-dir may contain only letters, digits, /, ., _, and -\n' >&2
    exit 1
  fi
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
  local -a flags=()
  [ -z "$ACCESS" ] || flags+=(--access "$ACCESS")
  [ -z "$ACCESS_PORT" ] || flags+=(--port "$ACCESS_PORT")
  [ -z "$TAILNET_HTTPS_PORT" ] || flags+=(--tailnet-port "$TAILNET_HTTPS_PORT")
  [ "$TAILSCALE_INSTALL_CONSENT" != true ] || flags+=(--install-tailscale)
  [ "$TAILNET_DEVICE_APPROVAL" != true ] || flags+=(--device-approval-confirmed)
  [ "$TAILNET_CERTIFICATE_CONSENT" != true ] || flags+=(--accept-certificate-name)
  [ -z "$SSH_TARGET" ] || flags+=(--ssh-target "$SSH_TARGET")
  [ -z "$SSH_PORT" ] || flags+=(--ssh-port "$SSH_PORT")
  [ "$REPO" = "$DEFAULT_REPO" ] || flags+=(--repo "$REPO")
  [ -z "$REF" ] || flags+=(--ref "$REF")
  [ "$DATA_DIR" = "$DEFAULT_DATA_DIR" ] || flags+=(--data-dir "$DATA_DIR")
  [ "$UPDATE_FEED" = "$DEFAULT_UPDATE_FEED" ] || flags+=(--update-feed "$UPDATE_FEED")
  [ -z "$UPDATE_ROOT_KEY" ] || flags+=(--update-root-key "$UPDATE_ROOT_KEY")
  [ -z "$DOMAIN" ] || flags+=(--domain "$DOMAIN")
  [ -z "$EMAIL" ] || flags+=(--email "$EMAIL")
  [ "$EXPLICIT_APPLY" != true ] || flags+=(--apply)
  [ "$SKIP_CODEX" != true ] || flags+=(--skip-codex)
  if [ -f "${0:-}" ] && [ -r "$0" ]; then
    printf 'sudo bash %q' "$0"
  else
    printf 'curl -fsSLo veduta-install.sh %q && sudo bash veduta-install.sh' "$INSTALL_URL"
  fi
  if [ "${#flags[@]}" -gt 0 ]; then printf ' %q' "${flags[@]}"; fi
}

# --- --update-root-key `@file` support ----------------------------------------------------
#
# A minisign public key is two lines of text, awkward to paste as a literal shell argument
# (`--update-root-key "$(cat veduta-root.pub)"` is what the flag has always accepted, and still
# does) -- `@/path/to/root.pub` is a second, friendlier form that reads the file itself. Resolved
# once, right after compute_rerun_cmd has already captured the short `@file` form for its own
# rerun hint -- so a rerun suggestion never has to embed the (possibly multi-line) key text.
resolve_update_root_key() {
  case "$UPDATE_ROOT_KEY" in
    @*)
      local key_file="${UPDATE_ROOT_KEY#@}"
      if [ ! -r "$key_file" ]; then
        printf 'error: --update-root-key @%s: file not found or not readable\n' "$key_file" >&2
        exit 1
      fi
      UPDATE_ROOT_KEY=$(cat "$key_file")
      if [ -z "$UPDATE_ROOT_KEY" ]; then
        printf 'error: --update-root-key @%s: file is empty\n' "$key_file" >&2
        exit 1
      fi
      ;;
  esac
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
    if [ ! -t 0 ] && [ "$EXPLICIT_APPLY" != true ]; then
      printf 'error: for interactive setup, download the installer to a file before running sudo.\n' >&2
      printf '  %s\n' "$RERUN_CMD" >&2
      exit 1
    fi
    PREVIEW_MODE=false
    return 0
  fi

  if [ "$EXPLICIT_APPLY" = "true" ]; then
    if [ "$ACCESS" = tailnet ]; then PREVIEW_MODE=false; return 0; fi
    if [ "${ACCESS:-tunnel}" = public ] && [ -n "$DOMAIN" ] && [ -n "$EMAIL" ]; then
      PREVIEW_MODE=false
      return 0
    fi
    if [ "${ACCESS:-tunnel}" = tunnel ] && [ -n "$SSH_TARGET" ]; then
      PREVIEW_MODE=false
      return 0
    fi
    printf 'error: unattended setup requires --access tunnel --ssh-target user@host, or --access public --domain host --email address\n' >&2
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
what an apply run would do. Download the script to a file and run it with sudo while logged
in over SSH. Unattended Tunnel access needs --apply --access tunnel --ssh-target user@host;
Public access needs --apply --access public --domain <domain> --email <email>.
Tailnet access needs an already connected node, --access tailnet,
--device-approval-confirmed and --accept-certificate-name with --apply.
EOF
  printf '\n' >&2
  printf '  user/group:      veduta:veduta (system account, no login shell)\n' >&2
  printf '  code checkout:   %s -> /opt/veduta (root:root 0755)\n' "$REPO" >&2
  printf '  ref:             %s\n' "${REF:-main (resolved to a commit SHA, or the pinned existing checkout on a rerun)}" >&2
  printf '  data directory:  %s (veduta:veduta 0700)\n' "$DATA_DIR" >&2
  printf '  vault keyfile:   /etc/veduta/vault.key (created only if absent, never rotated)\n' >&2
  printf '  update home:     /var/lib/veduta/updates/{releases,runtimes,bin,state,backups,tmp} (veduta:veduta 0700)\n' >&2
  if [ -n "$UPDATE_ROOT_KEY" ]; then
    printf '  update pinning:  %s (root:root 0644) -- feed %s\n' "$UPDATE_PINNING_PATH" "$UPDATE_FEED" >&2
  elif [ "$REPO" = "$DEFAULT_REPO" ] && [ "$UPDATE_FEED" = "$DEFAULT_UPDATE_FEED" ]; then
    printf '  update pinning:  bundled upstream public root on fresh installs; existing pinning preserved\n' >&2
  else
    printf '  update pinning:  custom source requires --update-root-key; existing pinning preserved\n' >&2
  fi
  printf '  systemd unit:    /etc/systemd/system/veduta.service + veduta.service.d/{override,bootstrap}.conf\n' >&2
  printf '  supervisor:      /var/lib/veduta/updates/bin/veduta-run (veduta:veduta 0755), ExecStart wraps through it\n' >&2
  printf '  node version:    %s\n' "$(preview_node_version_note)" >&2
  printf '  pnpm version:    %s\n' "$(preview_pnpm_version_note)" >&2
  if [ "$SKIP_CODEX" = "true" ]; then
    printf '  codex binary:    skipped (--skip-codex given) -- provision later with deploy/codex-setup.sh\n' >&2
  else
    printf '  codex binary:    provisioned into %s/codex via deploy/codex-setup.sh (best-effort, never fails the build stage)\n' "$DATA_DIR" >&2
  fi
  printf '\n' >&2
  printf 'flags: --access --port --tailnet-port --install-tailscale --device-approval-confirmed --accept-certificate-name --ssh-target --ssh-port --domain --email --repo --ref --data-dir --update-feed --update-root-key --apply --preview --json --skip-codex --help\n' >&2
  printf 'stage protocol: preview or --json only; schema: @veduta/protocol InstallerStageEventSchema\n' >&2
}

run_preview() {
  INSTALLER_STATE=preview
  print_preview_summary
  if [ "${ACCESS:-tunnel}" = tunnel ]; then
    printf '  access:          Tunnel access: no domain required\n' >&2
  elif [ "$ACCESS" = tailnet ]; then
    printf '  access:          Tailnet access: private HTTPS for approved computer and phone devices; no domain required\n' >&2
  else
    printf '  access:          Public access: domain and HTTPS required\n' >&2
  fi
  emit_event true
}

# --- Interactive prompting (reads /dev/tty, never stdin -- curl | sudo bash consumes stdin
# as the script source, so stdin cannot double as a prompt channel) --------------------------

prompt_tty() {
  local label="$1" default="${2:-}"
  INSTALLER_STATE=waiting-input
  emit_event true
  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$label" "$default" >/dev/tty
  else
    printf '%s: ' "$label" >/dev/tty
  fi
  IFS= read -r REPLY </dev/tty || return 1
  REPLY="${REPLY:-$default}"
  INSTALLER_STATE=planning
}

validate_access_args() {
  case "$ACCESS" in ''|tunnel|tailnet|public) ;; *) printf 'error: --access must be tunnel, tailnet, or public\n' >&2; exit 1 ;; esac
  local value
  for value in "$ACCESS_PORT" "$SSH_PORT" "$TAILNET_HTTPS_PORT"; do
    if [ -n "$value" ]; then
      case "$value" in *[!0-9]*) printf 'error: port must be an integer\n' >&2; exit 1 ;; esac
      if [ "${#value}" -gt 5 ] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        printf 'error: port must be between 1 and 65535\n' >&2; exit 1
      fi
    fi
  done
  if [ -n "$SSH_TARGET" ] && ! [[ "$SSH_TARGET" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@[a-zA-Z0-9][a-zA-Z0-9.:-]*$ ]]; then
    printf 'error: --ssh-target must be user@host without shell options\n' >&2; exit 1
  fi
  if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z][a-zA-Z0-9.-]*$ ]]; then
    printf 'error: --domain must be a DNS name without a scheme, port, or path\n' >&2; exit 1
  fi
  if [ -n "$EMAIL" ] && ! [[ "$EMAIL" =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]+$ ]]; then
    printf 'error: --email must be a certificate contact email\n' >&2; exit 1
  fi
}

choose_access() {
  local current_domain="" current_email="" current_data_dir="" default_access=tunnel
  if command -v tailscale >/dev/null 2>&1 && tailscale status --json --peers=false 2>/dev/null |
    grep '"BackendState"[[:space:]]*:[[:space:]]*"Running"' >/dev/null; then default_access=tailnet; fi
  if [ -f "$ACCESS_CONFIG" ]; then
    CURRENT_ACCESS=$(jq -er '.mode' "$ACCESS_CONFIG")
    CURRENT_ORIGIN=$(jq -er '.origin' "$ACCESS_CONFIG")
    CURRENT_PORT=$(jq -er '.port' "$ACCESS_CONFIG")
    CURRENT_TAILNET_PORT=$(jq -r '.tailnetPort // 443' "$ACCESS_CONFIG")
    if [ "$CURRENT_ACCESS" = tailnet ]; then TAILNET_HTTPS_PORT=${TAILNET_HTTPS_PORT:-$CURRENT_TAILNET_PORT}; fi
    current_domain=$(jq -r '.domain // ""' "$ACCESS_CONFIG")
    current_email=$(jq -r '.email // ""' "$ACCESS_CONFIG")
    SSH_TARGET=${SSH_TARGET:-$(jq -r '.sshTarget // ""' "$ACCESS_CONFIG")}
    SSH_PORT=${SSH_PORT:-$(jq -r '.sshPort // 22' "$ACCESS_CONFIG")}
    DATA_DIR=$(jq -er '.dataDir' "$ACCESS_CONFIG")
    EXISTING_ACCESS=true
  elif [ -f /etc/systemd/system/veduta.service.d/override.conf ]; then
    current_domain=$(sed -n 's/^Environment=VEDUTA_PUBLIC_DOMAIN=//p' /etc/systemd/system/veduta.service.d/override.conf | head -n1)
    current_email=$(sed -n 's/^Environment=VEDUTA_ACME_EMAIL=//p' /etc/systemd/system/veduta.service.d/override.conf | head -n1)
    current_data_dir=$(sed -n 's/^Environment=VEDUTA_DATA_DIR=//p' /etc/systemd/system/veduta.service.d/override.conf | head -n1)
    DATA_DIR=${current_data_dir:-$DATA_DIR}
    if [ -n "$current_domain" ]; then
      CURRENT_ACCESS=public
      CURRENT_ORIGIN="https://$current_domain"
      CURRENT_PORT=8788
      EXISTING_ACCESS=true
    fi
  fi
  if [ "$EXISTING_ACCESS" = true ]; then
    if [ "$SETUP_ONLY" != true ] && [ "$EXPLICIT_APPLY" != true ]; then
      printf '\nVeduta is installed at %s\n  1) Repair\n  2) Update access\n  3) Exit\n' "$CURRENT_ORIGIN" >&2
      prompt_tty 'Choose' 1
      case "$REPLY" in
        1) ACCESS=${ACCESS:-$CURRENT_ACCESS}; SETUP_ONLY=$MANAGE_ACCESS ;;
        2) SETUP_ONLY=true; EDIT_ACCESS=true ;;
        3) exit 0 ;;
        *) printf 'error: choose 1, 2, or 3\n' >&2; return 1 ;;
      esac
    elif [ "$SETUP_ONLY" = true ]; then
      ACCESS=${ACCESS:-$CURRENT_ACCESS}
    fi
  elif [ "$SETUP_ONLY" = true ]; then
    printf 'error: no installed access configuration. Run the installer first.\n' >&2
    return 1
  fi
  if [ -z "$ACCESS" ]; then
    if [ "$EXPLICIT_APPLY" = true ]; then
      ACCESS=tunnel
    else
      printf '\nHow will you open Veduta?\n  tunnel) Tunnel access — no domain required (computer via SSH)\n  tailnet) Private on all your devices — Tailscale\n  public) Public access — domain and HTTPS certificate required\n' >&2
      prompt_tty 'Access' "$default_access"
      ACCESS="$REPLY"
    fi
  fi
  ACCESS_PORT=${ACCESS_PORT:-${CURRENT_PORT:-8788}}
  if [ "$ACCESS" = public ]; then
    SSH_PORT=${SSH_PORT:-22}
    DOMAIN=${DOMAIN:-$current_domain}
    EMAIL=${EMAIL:-$current_email}
    if { [ -z "$DOMAIN" ] || [ "$EDIT_ACCESS" = true ]; } && [ "$EXPLICIT_APPLY" != true ]; then
      prompt_tty 'Public domain' "$current_domain"; DOMAIN="$REPLY"
    fi
    if { [ -z "$EMAIL" ] || [ "$EDIT_ACCESS" = true ]; } && [ "$EXPLICIT_APPLY" != true ]; then
      prompt_tty 'Certificate contact email' "$current_email"; EMAIL="$REPLY"
    fi
    if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
      printf 'error: Public access needs --domain and --email\n' >&2; return 1
    fi
    ORIGIN="https://$DOMAIN"
  elif [ "$ACCESS" = tunnel ]; then
    DOMAIN=""; EMAIL=""
    choose_tunnel_handoff
    ORIGIN="http://localhost:$ACCESS_PORT"
  elif [ "$ACCESS" = tailnet ]; then
    DOMAIN=""; EMAIL=""; SSH_PORT=${SSH_PORT:-22}
    choose_loopback_port
    if [ "$CURRENT_ACCESS" = tailnet ]; then ORIGIN="$CURRENT_ORIGIN"; fi
    printf '\nTailscale keeps Veduta private to devices authorized in your tailnet. Passkeys are still required.\nThe *.ts.net certificate hostname appears in public Certificate Transparency logs; the service and traffic stay private.\n' >&2
    if ! command -v tailscale >/dev/null 2>&1 && [ "$TAILSCALE_INSTALL_CONSENT" != true ]; then
      if [ "$EXPLICIT_APPLY" = true ]; then printf 'error: pass --install-tailscale to authorize installation, or use guided setup.\n' >&2; return 1; fi
      prompt_tty 'Install Tailscale on this VPS?' Y
      case "$REPLY" in y|Y|yes|YES) TAILSCALE_INSTALL_CONSENT=true ;; *) return 1 ;; esac
    fi
    if [ "$EXPLICIT_APPLY" = true ] && [ "$TAILNET_CERTIFICATE_CONSENT" != true ]; then
      printf 'error: unattended setup needs --accept-certificate-name for the disclosure above.\n' >&2; return 1
    fi
  fi
  validate_access_args
  validate_data_dir
  if [ "$EXISTING_ACCESS" = true ] && { [ "$ACCESS" != "$CURRENT_ACCESS" ] || [ "$ORIGIN" != "$CURRENT_ORIGIN" ]; }; then
    ACCESS_CHANGE=true
    SETUP_ONLY=true
  fi
  if [ "$MANAGE_ACCESS" = true ]; then SETUP_ONLY=true; fi
  if [ "$SETUP_ONLY" = true ] && { [ ! -f /usr/local/lib/veduta/access-transaction.sh ] || [ ! -f /usr/local/lib/veduta/tailnet-access.sh ] || [ ! -f /usr/local/lib/veduta/tailnet-backend-private.mjs ]; }; then
    printf 'error: this installation predates the current guided access. Run sudo bash veduta-install.sh --ref main and choose Repair with its current access first; then run sudo veduta access.\n' >&2
    return 1
  fi
  printf '\nPlan: %s access at %s\n  Production service, mandatory passkeys, data in %s.\n' "$ACCESS" "${ORIGIN:-an address assigned after Tailscale sign-in}" "$DATA_DIR" >&2
  if [ "$ACCESS_CHANGE" = true ]; then
    printf '  Register a new passkey at the new address to commit the change. Failure restores the old access.\n' >&2
  fi
  if [ "$EXPLICIT_APPLY" != true ]; then
    prompt_tty 'Continue?' Y
    case "$REPLY" in y|Y|yes|YES) ;; *) printf 'Cancelled; no changes made.\n' >&2; exit 0 ;; esac
  fi
}

port_in_use() {
  ss -H -ltn "sport = :$1" | grep . >/dev/null
}

choose_tunnel_handoff() {
  local detected_host="" detected_port=22 free_port banner
  if [ -n "${SSH_CONNECTION:-}" ]; then
    detected_host=$(printf '%s' "$SSH_CONNECTION" | awk '{print $3}')
    detected_port=$(printf '%s' "$SSH_CONNECTION" | awk '{print $4}')
  fi
  if [ -z "$SSH_TARGET" ] && [ -n "$detected_host" ]; then
    SSH_TARGET="${SUDO_USER:-root}@$detected_host"
  fi
  SSH_PORT=${SSH_PORT:-$detected_port}
  if [ "$EXPLICIT_APPLY" != true ] && { [ "$SETUP_ONLY" != true ] || [ "$EDIT_ACCESS" = true ] || [ -z "$SSH_TARGET" ]; }; then
    prompt_tty 'SSH destination (used from your computer)' "$SSH_TARGET"; SSH_TARGET="$REPLY"
    prompt_tty 'SSH port' "$SSH_PORT"; SSH_PORT="$REPLY"
  fi
  if [ "$EXPLICIT_APPLY" != true ] && [ "$EDIT_ACCESS" = true ]; then
    prompt_tty 'Veduta browser port' "$ACCESS_PORT"; ACCESS_PORT="$REPLY"
  fi
  if [ -z "$SSH_TARGET" ]; then
    printf 'error: no SSH destination. Run again with --access tunnel --ssh-target user@host.\n' >&2
    return 1
  fi
  validate_access_args
  choose_loopback_port

  verify_ssh_forwarding
  banner=$(timeout 5 bash -c 'exec 3<>/dev/tcp/"$1"/"$2"; IFS= read -r line <&3; printf "%s" "$line"' _ "${SSH_TARGET#*@}" "$SSH_PORT") || true
  case "$banner" in SSH-*) ;; *) printf 'error: SSH is not reachable at %s port %s. Check the destination and rerun with --ssh-target and --ssh-port.\n' "$SSH_TARGET" "$SSH_PORT" >&2; return 1 ;; esac
}

choose_loopback_port() {
  local free_port
  if { [ "$CURRENT_ACCESS" != tunnel ] && [ "$CURRENT_ACCESS" != tailnet ]; } || [ "$ACCESS_PORT" != "$CURRENT_PORT" ]; then
    if port_in_use "$ACCESS_PORT"; then
      ss -ltnp "sport = :$ACCESS_PORT" >&2
      free_port=$((10#$ACCESS_PORT + 1))
      while [ "$free_port" -le 65535 ] && port_in_use "$free_port"; do free_port=$((free_port + 1)); done
      if [ "$EXPLICIT_APPLY" = true ] || [ "$free_port" -gt 65535 ]; then
        printf 'error: port %s is occupied; choose a free port with --port.\n' "$ACCESS_PORT" >&2; return 1
      fi
      prompt_tty 'Port is occupied. Choose a free port for Veduta' "$free_port"
      ACCESS_PORT="$REPLY"
      validate_access_args
      if port_in_use "$ACCESS_PORT"; then printf 'error: chosen port is occupied\n' >&2; return 1; fi
    fi
  fi
}

verify_ssh_forwarding() {
  local context="user=${SSH_TARGET%@*}" policy permitted=false destination
  if [ -n "${SSH_CONNECTION:-}" ]; then
    context="$context,$(printf '%s' "$SSH_CONNECTION" | awk '{printf "addr=%s,host=%s,laddr=%s,lport=%s", $1,$1,$3,$4}')"
  fi
  if command -v sshd >/dev/null 2>&1; then policy=$(sshd -T -C "$context") || return 1; else policy=""; fi
  if printf '%s\n' "$policy" | grep -E '^allowtcpforwarding (yes|local)$' >/dev/null &&
     printf '%s\n' "$policy" | grep '^disableforwarding no$' >/dev/null; then
    for destination in $(printf '%s\n' "$policy" | sed -n 's/^permitopen //p'); do
      case "$destination" in any|"127.0.0.1:$ACCESS_PORT"|"127.0.0.1:*"|"*:$ACCESS_PORT"|"*:*") permitted=true ;; esac
    done
  fi
  if [ "$permitted" != true ]; then
    printf 'error: SSH policy does not permit this local forward. Inspect and correct it with: sudo sshd -T -C %q\n' "$context" >&2
    return 1
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

  choose_access
}

# True (exit 0) when $1 exists and is NOT itself a symlink (security review): the guard
# every legacy source-root/source-directory check in this section applies before its `-e`/`-d`
# test. This root-run installer must never follow a symlinked source root or subdirectory (a
# planted `~/.hermes/memories -> /root/...`, or `~/.openclaw` itself replaced by a symlink) into
# staging or detecting files from outside the legacy install it thinks it is reading.
not_symlink() {
  [ ! -L "$1" ]
}

# Echoes the first of $home/.openclaw, $home/.clawdbot, $home/.moltbot that exists AND is not
# itself a symlink (OpenClaw's former names, docs/references/04-onboarding-migration.md §B;
# symlink guard), or nothing and exits non-zero if none qualify. Shared by
# legacy_detect_stage (which only needs a yes/no) and stage_legacy_memory (which needs the
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

# True (exit 0) when $1/.hermes exists and is not a symlink (symlink guard).
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
# user_layout_stage, once DATA_DIR (owned by veduta:veduta) exists: held in memory until the
# layout stage exists, then persisted atomically.
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

# --- Legacy memory staging (docs/adr/0010-importer-trust-and-refusal.md) ------------------
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
# Refuses a symlinked source root outright, and a symlinked workspace/memories
# subdirectory (the one nested directory each vendor layout reads files out of) -- staging
# individual files through a symlinked *intermediate* directory component would let a planted
# symlink (e.g. `~/.hermes/memories -> /root/somewhere-else`) smuggle files from outside the
# legacy install past stage_legacy_file's own guard, which only ever checks the final path
# component.
#
# Stages into a sibling temporary directory ($staging_dir) and atomically `mv`s it into
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
  run env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get install -y git curl ca-certificates qrencode xz-utils jq iproute2
}

# Root-owned trust anchors for the signed self-update feed (issue #43,
# docs/adr/0013-signed-self-update.md's "Amendments" section): (re)written only when
# --update-root-key was given this run. A fresh install with no key simply leaves signed updates
# unconfigured (deploy/veduta-run's update-cli tolerates a missing $UPDATE_PINNING_PATH for as
# long as there is nothing to update); a RERUN with no key against a host that already has
# pinning from a previous run leaves that existing file untouched instead -- self-update stays
# configured against it, which is a different, non-inert outcome (see
# print_update_pinning_notice).
write_update_pinning() {
  local content tmp
  if [ -z "$UPDATE_ROOT_KEY" ]; then
    if [ -e "$UPDATE_PINNING_PATH" ]; then
      printf 'update pinning left untouched at %s (no --update-root-key given this run)\n' \
        "$UPDATE_PINNING_PATH" >&2
    else
      printf 'update pinning skipped (no --update-root-key)\n' >&2
    fi
    return 0
  fi
  content="{\"feedUrl\":\"$(escape_json_multiline "$UPDATE_FEED")\",\"rootPublicKey\":\"$(escape_json_multiline "$UPDATE_ROOT_KEY")\"}"
  tmp="$UPDATE_PINNING_PATH.tmp.$$"
  printf '%s' "$content" | run_quiet tee "$tmp"
  run chown root:root "$tmp"
  run chmod 0644 "$tmp"
  run mv "$tmp" "$UPDATE_PINNING_PATH"
  printf 'wrote update pinning to %s (feed: %s)\n' "$UPDATE_PINNING_PATH" "$UPDATE_FEED" >&2
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

  # The self-update home (issue #43, docs/adr/0013-signed-self-update.md's "Amendments"
  # section): veduta-owned, inside the existing ReadWritePaths, outside the root-owned git
  # checkout so a rerun's `git clean -fdx` (checkout_stage) never touches it.
  local update_subdir
  for update_subdir in releases runtimes bin state backups tmp; do
    run install -d -o veduta -g veduta -m 0700 "/var/lib/veduta/updates/$update_subdir"
  done
  write_update_pinning

  persist_legacy_seed
  stage_legacy_memory
}

checkout_stage() {
  local ref="${REF:-main}"
  if [ -d /opt/veduta/.git ]; then
    run git -C /opt/veduta remote set-url origin "$REPO"
    if [ -z "$REF" ]; then
      RESOLVED_SHA=$(git -C /opt/veduta rev-parse HEAD)
      printf 'Repair keeps the installed commit %s (pass --ref to select another source).\n' "$RESOLVED_SHA" >&2
    fi
  else
    run git clone --no-checkout "$REPO" /opt/veduta
  fi
  if [ -z "$RESOLVED_SHA" ]; then
    run git -C /opt/veduta fetch origin "$ref"
    RESOLVED_SHA=$(git -C /opt/veduta rev-parse FETCH_HEAD)
  fi
  # Check compatibility before removing dependencies or replacing runnable files.
  if ! git -C /opt/veduta cat-file -e "$RESOLVED_SHA:deploy/access-transaction.sh" 2>/dev/null ||
     ! git -C /opt/veduta cat-file -e "$RESOLVED_SHA:deploy/tailnet-access.sh" 2>/dev/null ||
     ! git -C /opt/veduta cat-file -e "$RESOLVED_SHA:deploy/tailnet-backend-private.mjs" 2>/dev/null; then
    printf 'error: this ref predates guided access. Existing runnable files were retained. Rerun with --ref main to explicitly select the current source installer.\n' >&2
    fail_stage 1
  fi
  run git -C /opt/veduta clean -fdx
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
  # -- deploy/veduta-run's legacy-checkout fallback (VEDUTA_LEGACY_ROOT, until a first update
  # ever runs) depends on this exact path. Fail loudly here, before systemctl ever gets a unit
  # that would just crash-loop.
  tsx_bin=/opt/veduta/packages/daemon/node_modules/.bin/tsx
  if [ ! -x "$tsx_bin" ]; then
    printf 'error: tsx binary not found at %s after build -- check that @veduta/daemon devDependencies installed correctly\n' "$tsx_bin" >&2
    fail_stage 1
  fi

  provision_codex
}

# Best-effort provisioning of the pinned Codex binary the ChatGPT subscription Model connection
# needs (issue #47, deploy/codex-setup.sh), folded into this stage rather than added as its own
# stage id -- exactly like Node above (see the header comment) -- and following the guided-
# provisioning pattern distilled from the Hermes agent installer in
# docs/references/12-hermes-installer-provisioning.md: silent by default (no prompt, no
# elevation beyond what this stage already runs with), skippable with --skip-codex, and a
# failure here is a warning with the exact manual retry command, NEVER fatal to the build stage
# -- unlike Node just above, which the daemon cannot run without at all, the ChatGPT subscription
# connection method is one optional Model connection among several. Time-boxed with `timeout`
# (this script has no existing long-running-step timeout helper to reuse, unlike the polling
# loops first_boot_stage uses for its own waits).
#
# codex-setup.sh's own `npm install --prefix <dataDir>/codex/vendor` and `mkdir -p` calls apply
# no ownership of their own -- this installer never drops privilege via runuser/sudo -u/su
# anywhere (every stage, including this one, runs as the same root the script itself must run as;
# see preflight_stage), so a root-run provision would otherwise leave <data-dir>/codex root-owned
# inside a data directory that user_layout_stage already created veduta:veduta -- the explicit
# chown below is what the daemon (running as `veduta` under ProtectHome=yes) needs to actually
# read and execute the provisioned binary.
provision_codex() {
  local codex_script=/opt/veduta/deploy/codex-setup.sh manual_hint

  manual_hint="sudo $codex_script --data-dir $DATA_DIR --yes && sudo chown -R veduta:veduta $DATA_DIR/codex"

  if [ "$SKIP_CODEX" = "true" ]; then
    printf 'skipping Codex provisioning (--skip-codex given) -- enable the ChatGPT subscription connection method later with:\n  %s\n' \
      "$manual_hint" >&2
    return 0
  fi

  if run timeout 300 "$codex_script" --data-dir "$DATA_DIR" --yes; then
    run chown -R veduta:veduta "$DATA_DIR/codex"
    printf 'provisioned the ChatGPT subscription connection method (Codex) into %s/codex\n' "$DATA_DIR" >&2
  else
    printf 'warning: the ChatGPT subscription connection method could not be provisioned; enable it later with:\n  %s\n' \
      "$manual_hint" >&2
  fi
  return 0
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

  # The supervisor wrapper (issue #43, docs/adr/0013-signed-self-update.md's "Amendments"
  # section): veduta-owned, inside /var/lib/veduta/updates (created by user_layout_stage), so a
  # broken release can never break its own rescuer. Copied fresh on every apply run -- the same
  # copy `veduta-run`'s own success path later overwrites atomically once an update has actually
  # run, so a rerun of this installer simply re-syncs it to whatever /opt/veduta now carries.
  local wrapper_dst=/var/lib/veduta/updates/bin/veduta-run
  run cp /opt/veduta/deploy/veduta-run "$wrapper_dst"
  run chown veduta:veduta "$wrapper_dst"
  run chmod 0755 "$wrapper_dst"

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
    # Self-update wiring (issue #43): the wrapper needs to know where the update home lives,
    # where the root-owned trust anchors are pinned, and where to fall back to when
    # releases/current does not exist yet (a fresh install that has never been through an
    # update) -- deploy/veduta-run's own header documents this same env contract.
    printf 'Environment=VEDUTA_UPDATE_HOME=/var/lib/veduta/updates\n'
    printf 'Environment=VEDUTA_UPDATE_PINNING=%s\n' "$UPDATE_PINNING_PATH"
    printf 'Environment=VEDUTA_LEGACY_ROOT=/opt/veduta\n'
    printf 'Restart=always\n'
    printf 'ExecStart=\n'
    printf 'ExecStart=%s\n' "$wrapper_dst"
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

auth_status() {
  if [ "$ACCESS" = public ]; then
    curl -fsSk --connect-timeout 3 --max-time 5 --resolve "${DOMAIN}:443:127.0.0.1" "$ORIGIN/api/auth/status"
  else
    curl -fsS --connect-timeout 3 --max-time 5 "http://127.0.0.1:$ACCESS_PORT/api/auth/status"
  fi
}

wait_for_gateway() {
  local waited=0
  while [ "$waited" -lt 180 ]; do
    if systemctl is-active --quiet "$SERVICE_NAME" && auth_status 2>/dev/null | jq -e '.mode == "production"' >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  printf 'error: Gateway not ready. Inspect: sudo journalctl -u %s -n 50\n' "$SERVICE_NAME" >&2
  return 1
}

first_boot_stage() {
  if [ "$SERVICE_NAME" = veduta ]; then run systemctl enable veduta; fi
  run systemctl restart "$SERVICE_NAME"
  wait_for_gateway
  if [ "$ACCESS" = tailnet ]; then tailnet_verify; fi
  if [ "$ACCESS" = public ]; then
    # Unlike the local readiness probe, this verifies DNS and the trusted certificate.
    curl -fsS --connect-timeout 5 --max-time 15 "$ORIGIN/api/auth/status" | jq -e '.mode == "production"' >/dev/null
  fi
}

print_handoff() {
  if [ "$ACCESS" = tailnet ]; then
    printf '\nUse this link on your computer and phone with Tailscale connected to the same personal account.\nApprove each device in Tailscale before opening Veduta; devices outside your tailnet cannot reach it.\n' >&2
  fi
  if [ "$ACCESS" = tunnel ]; then
    printf '\nRun this on your computer, not on the VPS. Keep that terminal open:\n' >&2
    printf '  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:%s:127.0.0.1:%s -p %s %s\n' \
      "$ACCESS_PORT" "$ACCESS_PORT" "$SSH_PORT" "$SSH_TARGET" >&2
    printf 'If your computer reports "Address already in use", close the existing forward or run sudo veduta access on the VPS to choose another stable port.\n' >&2
  fi
}

pairing_stage() {
  print_handoff
  if auth_status | jq -e '.passkeyRegistered == true' >/dev/null; then
    printf '\nOpen Veduta: %s\nA passkey is already registered.\n' "$ORIGIN" >&2
    return 0
  fi
  local url="$ORIGIN/setup?code=$BOOTSTRAP_CODE" waited=0
  printf '\nOpen this setup link (expires in 60 minutes):\n  %s\n' "$url" >&2
  if [ "$ACCESS" != tunnel ] && command -v qrencode >/dev/null 2>&1; then
    qrencode -t ANSIUTF8 "$url" >&2
  fi
  INSTALLER_STATE=waiting-passkey
  emit_event true
  write_stage_file true
  printf '\nWaiting for passkey registration. Continue in your browser.\n' >&2
  if [ "$ACCESS_CHANGE" = true ]; then
    printf 'Temporary access has a 15-minute total deadline, including connection and certificate checks. Ctrl+C restores the previous access.\n' >&2
  else
    printf 'Ctrl+C leaves Veduta running. Resume later with: sudo veduta setup\n' >&2
  fi
  while [ "$waited" -lt 3600 ]; do
    if ! systemctl is-active --quiet "$SERVICE_NAME"; then
      printf 'error: the setup service stopped; run sudo veduta setup to recover.\n' >&2
      return 1
    fi
    if auth_status 2>/dev/null | jq -e '.mode == "production" and .passkeyRegistered == true' >/dev/null 2>&1; then
      printf 'Passkey registered. Continue onboarding in Veduta.\n' >&2
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  printf 'Setup link expired. Get a new one with: sudo veduta setup\n' >&2
  return 1
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
      printf 'recover your setup link without reinstalling:\n  sudo veduta setup\n' >&2
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
  INSTALLER_STATE=failed
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
  if declare -F access_abort >/dev/null; then access_abort || true; fi
  emit_failure_event
  exit "${1:-1}"
}

on_error() {
  local exit_code=$?
  trap - ERR INT TERM
  if declare -F access_abort >/dev/null; then access_abort || true; fi
  emit_failure_event
  exit "$exit_code"
}

on_interrupt() {
  trap - ERR INT TERM
  if declare -F access_abort >/dev/null; then access_abort || true; fi
  emit_failure_event
  exit 130
}

on_terminate() {
  trap - ERR INT TERM
  if declare -F access_abort >/dev/null; then access_abort || true; fi
  emit_failure_event
  exit 143
}

# --- Apply mode driver -----------------------------------------------------------------------

run_stage() {
  local id="$1" fn="$2"
  CURRENT_STAGE="$id"
  set_stage_status "$id" "running"
  INSTALLER_STATE=running
  local i
  for ((i = 0; i < ${#STAGE_IDS[@]}; i++)); do
    if [ "${STAGE_IDS[$i]}" = "$id" ]; then
      printf '\n[%s/%s] %s\n' "$((i + 1))" "${#STAGE_IDS[@]}" "${STAGE_TITLES[$i]}" >&2
      break
    fi
  done
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
  RERUN_CMD=$(compute_rerun_cmd)
  INSTALL_LOG=$(mktemp /var/log/veduta-install.XXXXXX.log)
  if [ "$SETUP_ONLY" != true ]; then
  run_stage legacy-detect legacy_detect_stage
  run_stage deps deps_stage
  run_stage user-layout user_layout_stage
  run_stage checkout checkout_stage
  if [ -z "$UPDATE_ROOT_KEY" ] && [ ! -e "$UPDATE_PINNING_PATH" ] && [ "$REPO" = "$DEFAULT_REPO" ] && [ "$UPDATE_FEED" = "$DEFAULT_UPDATE_FEED" ]; then
    UPDATE_ROOT_KEY=$(cat /opt/veduta/docs/keys/root.pub)
    write_update_pinning
  fi
  run_stage build build_stage
  run_stage vault-keyfile vault_keyfile_stage
  run_stage systemd-unit systemd_unit_stage
  run install -d -o root -g root -m 0755 /usr/local/lib/veduta
  run install -o root -g root -m 0755 /opt/veduta/deploy/install.sh /usr/local/lib/veduta/install.sh
  run install -o root -g root -m 0644 /opt/veduta/deploy/access-transaction.sh /usr/local/lib/veduta/access-transaction.sh
  run install -o root -g root -m 0644 /opt/veduta/deploy/tailnet-access.sh /usr/local/lib/veduta/tailnet-access.sh
  run install -o root -g root -m 0644 /opt/veduta/deploy/tailnet-backend-private.mjs /usr/local/lib/veduta/tailnet-backend-private.mjs
  run install -o root -g root -m 0755 /opt/veduta/deploy/veduta /usr/local/bin/veduta
  else
    local skipped_stage
    for skipped_stage in legacy-detect deps user-layout checkout build vault-keyfile systemd-unit; do
      set_stage_status "$skipped_stage" skipped
    done
  fi
  . /usr/local/lib/veduta/access-transaction.sh
  . /usr/local/lib/veduta/tailnet-access.sh
  if [ "$ACCESS" = tailnet ]; then tailnet_prepare; fi
  access_prepare
  tailnet_stage_route
  run_stage first-boot first_boot_stage
  run_stage pairing pairing_stage
  access_commit
  INSTALLER_STATE=complete
  emit_event false
  write_stage_file false
  trap - ERR INT TERM

  if [ -n "$RESOLVED_SHA" ]; then printf '\nresolved commit: %s\n' "$RESOLVED_SHA" >&2; fi
  printf 'done -- veduta is running at %s\n' "$ORIGIN" >&2
  if [ -f "$UPDATE_PINNING_PATH" ]; then
    printf "Signed updates are configured.\n" >&2
  else
    print_update_pinning_notice
  fi
}

# Printed last, deliberately -- not buried mid-stage next to write_update_pinning's own one-line
# log message: no upstream root key exists yet to default to (a fabricated placeholder would pin
# trust to a key nobody holds, worse than leaving it unconfigured), so a plain install with no
# --update-root-key silently has self-update disabled unless this notice is loud and impossible
# to miss at the very end of the run. A RERUN with no --update-root-key against a host that
# already has pinning from a previous run is a different, non-inert case (write_update_pinning
# leaves the existing file untouched above) -- the two are told apart here by checking whether
# $UPDATE_PINNING_PATH actually exists, not by $UPDATE_ROOT_KEY alone, so a preserved pinning is
# never misreported as disabled.
print_update_pinning_notice() {
  if [ -n "$UPDATE_ROOT_KEY" ]; then
    return 0
  fi
  if [ -e "$UPDATE_PINNING_PATH" ]; then
    printf '\n================================================================\n' >&2
    printf 'NOTICE: signed self-update pinning already configured -- left untouched\n' >&2
    printf '================================================================\n' >&2
    printf 'No --update-root-key was given on this run, so %s\n' "$UPDATE_PINNING_PATH" >&2
    printf 'was not rewritten. A previous run already pinned a feed and root key there, so\n' >&2
    printf 'self-update remains configured against it -- this is not the inert case, nothing\n' >&2
    printf 'was disabled. Pass --update-root-key only if you want to change the pinned feed\n' >&2
    printf 'or key:\n' >&2
    printf '  %s --update-root-key @/path/to/root.pub\n' "$RERUN_CMD" >&2
    printf '================================================================\n' >&2
    return 0
  fi
  printf '\n================================================================\n' >&2
  printf 'NOTICE: signed self-update is INERT on this install\n' >&2
  printf '================================================================\n' >&2
  printf 'No --update-root-key was given, so %s was not written: this\n' "$UPDATE_PINNING_PATH" >&2
  printf 'instance has no trust anchor to verify a release against and will never apply a\n' >&2
  printf 'signed update until one is pinned. This is deliberate, not an oversight -- there is\n' >&2
  printf 'no fabricated placeholder key here; see RELEASING.md for how the upstream key is\n' >&2
  printf 'published once it exists.\n' >&2
  printf '\n' >&2
  printf 'Once a root key is available, pin it with:\n' >&2
  printf '  %s --update-root-key @/path/to/root.pub\n' "$RERUN_CMD" >&2
  printf '================================================================\n' >&2
}

# --- Entry point -------------------------------------------------------------------------

main() {
  parse_args "$@"
  if [ "$SHOW_HELP" = "true" ]; then
    print_help
    exit 0
  fi
  validate_data_dir
  validate_access_args
  RERUN_CMD=$(compute_rerun_cmd)
  resolve_update_root_key
  determine_mode
  if [ "$PREVIEW_MODE" = "true" ]; then
    run_preview
    exit 0
  fi
  # One root-owned installer owns access changes at a time.
  if [ "$(id -u)" -eq 0 ]; then
    exec 9>/run/lock/veduta-setup.lock
    if ! flock -n 9; then printf 'error: another Veduta setup is running\n' >&2; exit 1; fi
  fi
  run_apply
}

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then main "$@"; fi
