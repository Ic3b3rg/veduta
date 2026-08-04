#!/usr/bin/env bash
# Veduta release ceremony -- the maintainer-side half of signed self-update (issue #43,
# docs/adr/0013-signed-self-update.md, "Amendments" section; see RELEASING.md for the full
# ceremony this script is one step of). CI (.github/workflows/release.yml) never holds the
# signing key: it builds veduta-vX.Y.Z-linux.tar.gz and an UNSIGNED release.json, then this
# script -- run by hand, on the maintainer's machine, against the real minisign CLI -- signs
# it and later promotes a soaked release into the gated feed (feed/stable.json).
#
# Usage:
#   deploy/release.sh sign <release.json> --key <signing.key>
#   deploy/release.sh promote <release.json> <release.json.minisig> \
#     --signing-pub <signing.pub> --signing-pub-sig <signing.pub.minisig> \
#     --out feed/stable.json --artifact-url <url> [--key-id <id>]
#   deploy/release.sh verify <stable.json> --root-pub <root.pub>
#
# `stable.json`'s shape matches `UpdateManifestSchema` in packages/protocol/src/update.ts
# exactly: `release` is the base64 of the EXACT signed release.json bytes (never
# re-serialized -- decoding and re-encoding the object would change key order/whitespace and
# break signature verification the moment a byte differs), `releaseSig`/`signingKey.pub`/
# `signingKey.rootSig` are the verbatim text of the corresponding minisign files.
#
# No jq, no python3: like deploy/install.sh's own escape_json_string, JSON is hand-assembled
# with printf/awk/sed. The only multi-line values this script ever embeds into JSON are
# minisign key/signature files, which are always base64 plus a few fixed English words -- never
# a literal backslash or double quote -- so a plain backslash-n/backslash-quote escaper is
# sufficient and is checked for that assumption (see json_unescape_to_file). Base64 uses
# `openssl base64` rather than the `base64` CLI because its `-d`/`-A` flags are identical on
# macOS and Linux, unlike GNU vs. BSD `base64`.
#
# This script must remain parseable by bash 3.2 (macOS's system bash), the same constraint
# deploy/install.sh documents: no associative arrays, no `${var,,}`, no other bash-4-only
# syntax anywhere in the file.
#
# No secrets are ever echoed: the signing/root secret key files are only ever passed to
# `minisign` by path -- `minisign -S` prompts for the passphrase on the controlling tty itself,
# this script never reads or forwards it.

set -Eeuo pipefail

# --- Helpers ----------------------------------------------------------------------------

error() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || error "no such file: $1"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || error "required tool not found on PATH: $1"
}

# Extracts the string value of a top-level (or single-nested) JSON field from a file this
# script itself wrote in the fixed one-field-per-line layout below (`printf '  "name": "%s"'`
# per line) -- not a general JSON parser. Field names in this schema are unique across the
# whole document, so a single anchored grep is enough.
json_get_field() {
  local file="$1" name="$2" line
  line=$(grep -m1 "\"$name\":" "$file") || error "field '$name' not found in $file"
  printf '%s' "$line" | sed -E 's/^[[:space:]]*"'"$name"'":[[:space:]]*"(.*)",?[[:space:]]*$/\1/'
}

# Escapes a file's bytes into a JSON string body (no surrounding quotes): backslash and double
# quote get their standard JSON escapes, real newlines become the two characters \n. Mirrors
# deploy/install.sh's escape_json_string, extended to multiple lines.
json_escape_file() {
  awk '
    BEGIN { first = 1 }
    {
      gsub(/\\/, "\\\\")
      gsub(/"/, "\\\"")
      if (!first) printf "\\n"
      printf "%s", $0
      first = 0
    }
  ' "$1"
}

# Reverses json_escape_file: turns a JSON string body (with literal backslash-n /
# backslash-quote sequences) back into a real multi-line file, terminated by exactly one
# trailing newline -- every minisign-produced file (pubkey or .minisig) ends that way, and
# minisign verifies exact bytes, so json_escape_file deliberately does not encode a trailing
# newline itself (there is always exactly one to add back). Refuses, rather than guesses, if a
# raw backslash survives the known substitutions -- that would mean the original text had an
# escaped backslash, which never happens for minisign key/signature files (base64 plus a
# handful of fixed English words) and this script does not attempt to handle.
json_unescape_to_file() {
  local escaped="$1" out="$2"
  printf '%s\n' "$escaped" | sed 's/\\n/\n/g; s/\\"/"/g' >"$out"
  # shellcheck disable=SC1003 # a literal single backslash is exactly what this checks for
  if grep -qF '\' "$out"; then
    error "embedded minisign text at $out contains an escaped backslash this script does not handle"
  fi
}

# minisign's default untrusted comment on a public key file is
# "untrusted comment: minisign public key <HEX>" -- pull the id out of it so the feed's
# signingKey.keyId always names the actual key by default. --key-id overrides this.
extract_key_id() {
  local pub_file="$1" line
  line=$(head -n1 "$pub_file")
  printf '%s' "${line##*key }"
}

usage() {
  cat >&2 <<'EOF'
Veduta release ceremony (see RELEASING.md for the full walkthrough)

Usage:
  deploy/release.sh sign <release.json> --key <signing.key>
  deploy/release.sh promote <release.json> <release.json.minisig>
      --signing-pub <signing.pub> --signing-pub-sig <signing.pub.minisig>
      --out <stable.json> --artifact-url <url> [--key-id <id>]
  deploy/release.sh verify <stable.json> --root-pub <root.pub>
  deploy/release.sh --help

sign     Signs the canonical release.json bytes with the daily signing key, producing
         <release.json>.minisig via the real minisign CLI (`minisign -S`). Prompts for the
         signing key's passphrase on the controlling tty; never reads or echoes it itself.
sign uses the release's own artifactName field (packages/protocol/src/update.ts,
         ReleaseMetadataSchema) as the minisign trusted comment -- this is the name+contents
         binding that closes the rename/downgrade hole documented in the ADR's Amendments.

promote  Assembles feed/stable.json (schema: UpdateManifestSchema) from a signed release.json,
         its .minisig, and the signing key's root-signed certificate. Run only after a release
         has soaked -- promotion is what makes it visible to the update feed.

verify   Re-verifies the full trust chain (root -> signing key -> release metadata) of an
         already-promoted stable.json against a root public key, with the real minisign CLI,
         as a maintainer pre-flight before committing feed/stable.json.
EOF
}

# --- sign ---------------------------------------------------------------------------------

cmd_sign() {
  local release_json="${1:-}" key_path="" artifact_name
  [ -n "$release_json" ] || error "sign: missing <release.json>"
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --key)
        key_path="${2:-}"
        shift 2
        ;;
      *)
        error "sign: unknown argument: $1"
        ;;
    esac
  done
  [ -n "$key_path" ] || error "sign: --key <signing.key> is required"
  require_file "$release_json"
  require_file "$key_path"
  require_tool minisign

  artifact_name=$(json_get_field "$release_json" artifactName)
  [ -n "$artifact_name" ] || error "sign: could not read artifactName from $release_json"

  minisign -S -s "$key_path" -m "$release_json" -t "$artifact_name"

  printf 'signed %s -> %s.minisig (trusted comment: %s)\n' "$release_json" "$release_json" "$artifact_name" >&2
  printf 'next: upload %s.minisig as a release asset alongside %s, then run:\n' "$release_json" "$release_json" >&2
  printf '  deploy/release.sh promote %s %s.minisig \\\n' "$release_json" "$release_json" >&2
  printf '    --signing-pub <signing.pub> --signing-pub-sig <signing.pub.minisig> \\\n' >&2
  printf '    --out feed/stable.json --artifact-url <release asset URL>\n' >&2
}

# --- promote --------------------------------------------------------------------------------

cmd_promote() {
  local release_json="${1:-}" release_sig="${2:-}"
  local signing_pub="" signing_pub_sig="" out="" artifact_url="" key_id=""
  [ -n "$release_json" ] || error "promote: missing <release.json>"
  [ -n "$release_sig" ] || error "promote: missing <release.json.minisig>"
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --signing-pub)
        signing_pub="${2:-}"
        shift 2
        ;;
      --signing-pub-sig)
        signing_pub_sig="${2:-}"
        shift 2
        ;;
      --out)
        out="${2:-}"
        shift 2
        ;;
      --artifact-url)
        artifact_url="${2:-}"
        shift 2
        ;;
      --key-id)
        key_id="${2:-}"
        shift 2
        ;;
      *)
        error "promote: unknown argument: $1"
        ;;
    esac
  done
  [ -n "$signing_pub" ] || error "promote: --signing-pub is required"
  [ -n "$signing_pub_sig" ] || error "promote: --signing-pub-sig is required"
  [ -n "$out" ] || error "promote: --out is required"
  [ -n "$artifact_url" ] || error "promote: --artifact-url is required"
  require_file "$release_json"
  require_file "$release_sig"
  require_file "$signing_pub"
  require_file "$signing_pub_sig"
  require_tool openssl

  if [ -z "$key_id" ]; then
    key_id=$(extract_key_id "$signing_pub")
  fi
  [ -n "$key_id" ] || error "promote: could not determine a key id -- pass --key-id explicitly"

  local release_b64 release_sig_text pub_text pub_sig_text
  release_b64=$(openssl base64 -A -in "$release_json")
  release_sig_text=$(json_escape_file "$release_sig")
  pub_text=$(json_escape_file "$signing_pub")
  pub_sig_text=$(json_escape_file "$signing_pub_sig")

  mkdir -p "$(dirname "$out")"
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "release": "%s",\n' "$release_b64"
    printf '  "releaseSig": "%s",\n' "$release_sig_text"
    printf '  "signingKey": {\n'
    printf '    "pub": "%s",\n' "$pub_text"
    printf '    "rootSig": "%s",\n' "$pub_sig_text"
    printf '    "keyId": "%s"\n' "$key_id"
    printf '  },\n'
    printf '  "artifactUrl": "%s"\n' "$artifact_url"
    printf '}\n'
  } >"$out"

  printf 'wrote %s (schemaVersion 1, keyId %s)\n' "$out" "$key_id" >&2
  printf 'next: deploy/release.sh verify %s --root-pub <root.pub>, then commit %s\n' "$out" "$out" >&2
}

# --- verify -------------------------------------------------------------------------------

cmd_verify() {
  local stable_json="${1:-}" root_pub=""
  [ -n "$stable_json" ] || error "verify: missing <stable.json>"
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --root-pub)
        root_pub="${2:-}"
        shift 2
        ;;
      *)
        error "verify: unknown argument: $1"
        ;;
    esac
  done
  [ -n "$root_pub" ] || error "verify: --root-pub is required"
  require_file "$stable_json"
  require_file "$root_pub"
  require_tool minisign
  require_tool openssl

  # Deliberately not `local`: an EXIT trap runs after this function's scope has already been
  # torn down (e.g. when `set -e` aborts on a failed minisign -V below), and a `local`
  # variable would then read as unset under `set -u`, turning a verification failure into a
  # confusing "unbound variable" error instead of the real one.
  tmp=$(mktemp -d)
  trap 'rm -rf "${tmp:-}"' EXIT
  chmod 700 "$tmp"

  local release_b64 release_sig_escaped pub_escaped root_sig_escaped
  release_b64=$(json_get_field "$stable_json" release)
  release_sig_escaped=$(json_get_field "$stable_json" releaseSig)
  pub_escaped=$(json_get_field "$stable_json" pub)
  root_sig_escaped=$(json_get_field "$stable_json" rootSig)

  printf '%s' "$release_b64" | openssl base64 -d -A >"$tmp/release.json"
  json_unescape_to_file "$release_sig_escaped" "$tmp/release.json.minisig"
  json_unescape_to_file "$pub_escaped" "$tmp/signing.pub"
  json_unescape_to_file "$root_sig_escaped" "$tmp/signing.pub.minisig"

  # Step 1: the signing key's certificate must be rooted -- its trusted comment must be the
  # fixed literal "signing.pub" (packages/daemon/src/update/minisign.ts,
  # SIGNING_KEY_CERT_TRUSTED_COMMENT) and the root key's signature over it must verify.
  local signing_cert_comment
  signing_cert_comment=$(sed -n '3p' "$tmp/signing.pub.minisig")
  case "$signing_cert_comment" in
    'trusted comment: signing.pub') ;;
    *)
      error "signing key certificate trusted comment mismatch: expected 'trusted comment: signing.pub', got '$signing_cert_comment'"
      ;;
  esac
  minisign -V -p "$root_pub" -m "$tmp/signing.pub" -x "$tmp/signing.pub.minisig" >/dev/null
  printf 'OK: signing key certificate verified against root\n' >&2

  # Step 2: the release metadata's signature must verify against that now-rooted signing key,
  # and its trusted comment must be the exact artifactName inside the release bytes --
  # otherwise a feed could re-advertise an old, still-validly-signed release under a different
  # name (the downgrade hole the ADR's Amendments close).
  local artifact_name release_comment
  artifact_name=$(json_get_field "$tmp/release.json" artifactName)
  release_comment=$(sed -n '3p' "$tmp/release.json.minisig")
  case "$release_comment" in
    "trusted comment: $artifact_name") ;;
    *)
      error "release signature trusted comment mismatch: expected artifact '$artifact_name', got '$release_comment'"
      ;;
  esac
  minisign -V -p "$tmp/signing.pub" -m "$tmp/release.json" -x "$tmp/release.json.minisig" >/dev/null
  printf 'OK: release metadata verified against signing key\n' >&2

  printf 'OK: full chain verified (root -> signing key -> release "%s")\n' "$artifact_name" >&2
}

# --- main -----------------------------------------------------------------------------------

main() {
  if [ $# -eq 0 ]; then
    usage
    exit 1
  fi
  case "$1" in
    sign)
      shift
      cmd_sign "$@"
      ;;
    promote)
      shift
      cmd_promote "$@"
      ;;
    verify)
      shift
      cmd_verify "$@"
      ;;
    --help | -h)
      usage
      ;;
    *)
      printf 'unknown subcommand: %s\n\n' "$1" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
