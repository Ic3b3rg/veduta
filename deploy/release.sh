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
#     --out feed/stable.json [--artifact-url <url>] [--key-id <id>]
#   deploy/release.sh verify <stable.json> --root-pub <root.pub>
#
# `stable.json`'s shape matches `UpdateManifestSchema` in packages/protocol/src/update.ts
# exactly: `release` is the base64 of the EXACT signed release.json bytes (never
# re-serialized -- decoding and re-encoding the object would change key order/whitespace and
# break signature verification the moment a byte differs), `releaseSig`/`signingKey.pub`/
# `signingKey.rootSig` are the verbatim text of the corresponding minisign files.
#
# `--artifact-url` is required only for releases whose signed metadata has no `artifactUrl`
# (issue #46, ReleaseMetadataSchema in packages/protocol/src/update.ts -- the field is optional
# there so releases signed before it existed still parse). When the signed release.json DOES
# carry an `artifactUrl`, that value wins: `--artifact-url` becomes optional, and if given must
# match the signed one exactly, or promotion fails rather than silently advertising a download
# target the signature does not cover.
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
# whole document, so a single anchored grep is enough. The match is anchored to the start of
# the line (only leading whitespace before the quoted name) rather than a bare substring
# search: an unanchored grep against a `release.json` that is not this script's own 2-space
# pretty-print -- anything compact, e.g. minified to one line -- can match the *whole
# document* as "the line", and if the trailing sed then fails to isolate a value it prints
# that unchanged input right back out, silently handing the caller an entire JSON blob as if
# it were a field's value. Prints failure (empty output, non-zero return) instead whenever
# the anchored match is missing OR the sed substitution did not actually fire -- detected by
# comparing the "extracted" value against the whole matched line, since a real string value
# can never equal a line that still carries the field's own name, colon and quoting.
json_get_field_or_fail() {
  local file="$1" name="$2" line value
  line=$(grep -m1 "^[[:space:]]*\"$name\":" "$file") || return 1
  value=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*"'"$name"'":[[:space:]]*"(.*)",?[[:space:]]*$/\1/')
  [ "$value" != "$line" ] || return 1
  printf '%s' "$value"
}

json_get_field() {
  local file="$1" name="$2"
  json_get_field_or_fail "$file" "$name" || error "field '$name' not found (or not in the expected one-field-per-line layout) in $file"
}

# Like json_get_field, but prints the empty string instead of failing when the field is absent
# -- for fields ReleaseMetadataSchema (packages/protocol/src/update.ts) marks `.optional()`,
# whose absence is expected in metadata signed before the field existed. Shares
# json_get_field_or_fail's anchoring and malformed-match detection, so a compact document
# fails the same way here as it does for json_get_field -- silently returning "absent" would
# be just as wrong as silently returning a JSON blob.
json_get_optional_field() {
  local file="$1" name="$2"
  json_get_field_or_fail "$file" "$name" || true
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

# Pulls the authority (host, plus port when present) out of a URL via plain parameter
# expansion -- no jq, no python3: strip the scheme up to "://", then keep everything up to
# the first remaining "/". Used only to call the host out on its own line for a human to
# actually look at (see cmd_sign): the full artifactUrl is printed too, but the host is
# the part a maintainer signing a CI-computed URL needs to notice if it is wrong.
url_host() {
  local url="$1" rest
  rest="${url#*://}"
  printf '%s' "${rest%%/*}"
}

usage() {
  cat >&2 <<'EOF'
Veduta release ceremony (see RELEASING.md for the full walkthrough)

Usage:
  deploy/release.sh sign <release.json> --key <signing.key>
  deploy/release.sh promote <release.json> <release.json.minisig>
      --signing-pub <signing.pub> --signing-pub-sig <signing.pub.minisig>
      --out <stable.json> [--artifact-url <url>] [--key-id <id>]
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
         --artifact-url is required only for releases whose signed metadata has no
         `artifactUrl` (issue #46). When the signed release.json carries one, that value is
         what goes into the manifest, --artifact-url is optional, and passing a conflicting
         value is an error rather than a silent override.

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

  # CI computes artifactUrl (issue #46, ReleaseMetadataSchema in packages/protocol/src/update.ts)
  # from the repository, the tag and the asset name, and it becomes authoritative the moment
  # this signature exists (promote prefers it over any --artifact-url, verify cross-checks
  # against it) -- so the maintainer signing it must actually see it first, not just the
  # trusted comment. The host is called out on its own line because it is the part worth a
  # human's attention: the ADR keeps the signing key out of CI precisely so repository write
  # access is not release-signing access, which blind-signing a CI-computed download host
  # would quietly undo.
  local artifact_url
  artifact_url=$(json_get_optional_field "$release_json" artifactUrl)
  if [ -n "$artifact_url" ]; then
    printf 'about to sign artifactUrl: %s\n' "$artifact_url" >&2
    printf '  host: %s\n' "$(url_host "$artifact_url")" >&2
  else
    printf 'about to sign: release metadata has no artifactUrl (signed before issue #46 added the field)\n' >&2
  fi

  minisign -S -s "$key_path" -m "$release_json" -t "$artifact_name"

  printf 'signed %s -> %s.minisig (trusted comment: %s)\n' "$release_json" "$release_json" "$artifact_name" >&2
  printf 'next: upload %s.minisig as a release asset alongside %s, then run:\n' "$release_json" "$release_json" >&2
  printf '  deploy/release.sh promote %s %s.minisig \\\n' "$release_json" "$release_json" >&2
  printf '    --signing-pub <signing.pub> --signing-pub-sig <signing.pub.minisig> \\\n' >&2
  printf '    --out feed/stable.json [--artifact-url <release asset URL>]\n' >&2
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
  require_file "$release_json"
  require_file "$release_sig"
  require_file "$signing_pub"
  require_file "$signing_pub_sig"
  require_tool openssl

  if [ -z "$key_id" ]; then
    key_id=$(extract_key_id "$signing_pub")
  fi
  [ -n "$key_id" ] || error "promote: could not determine a key id -- pass --key-id explicitly"

  # artifactUrl (issue #46, ReleaseMetadataSchema in packages/protocol/src/update.ts) is signed
  # into the release metadata itself whenever the release that produced it was built to carry
  # one. When it is present, it -- not the flag -- is the value that goes into the manifest: a
  # maintainer passing --artifact-url anyway must match it exactly, since a mismatch would mean
  # promoting to a download target the signature does not cover. Only a release signed before
  # this field existed (no signed artifactUrl at all) still needs --artifact-url supplied here.
  local artifact_url_signed
  artifact_url_signed=$(json_get_optional_field "$release_json" artifactUrl)
  if [ -n "$artifact_url_signed" ]; then
    if [ -n "$artifact_url" ] && [ "$artifact_url" != "$artifact_url_signed" ]; then
      error "promote: --artifact-url '$artifact_url' does not match the signed artifactUrl '$artifact_url_signed' in $release_json"
    fi
    artifact_url="$artifact_url_signed"
  else
    [ -n "$artifact_url" ] || error "promote: --artifact-url is required (release metadata has no signed artifactUrl)"
  fi

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

  # Step 3: when the release metadata carries a signed artifactUrl (issue #46,
  # ReleaseMetadataSchema in packages/protocol/src/update.ts), it must equal the manifest's own
  # artifactUrl field exactly. This is the one inconsistency the chain verification above
  # cannot catch: a hand-edited feed/stable.json, or a merge that resolved the field wrong,
  # still verifies signature-wise, but every installed instance would then refuse the release
  # at apply time with "manifest artifactUrl does not match the signed artifactUrl" -- an
  # outage found from user reports instead of at this last gate before the feed is committed.
  # A release signed before the field existed carries none, and is verified exactly as before.
  local artifact_url_signed
  artifact_url_signed=$(json_get_optional_field "$tmp/release.json" artifactUrl)
  if [ -n "$artifact_url_signed" ]; then
    local artifact_url_manifest
    artifact_url_manifest=$(json_get_field "$stable_json" artifactUrl)
    if [ "$artifact_url_signed" != "$artifact_url_manifest" ]; then
      error "manifest artifactUrl '$artifact_url_manifest' does not match the signed artifactUrl '$artifact_url_signed'"
    fi
    printf 'OK: manifest artifactUrl matches the signed artifactUrl\n' >&2
  fi

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
