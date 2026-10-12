# Releasing Veduta

The release workflow is defined by [ADR-0013](docs/adr/0013-signed-self-update.md), including its
amendments. [CI](.github/workflows/release.yml) builds and attests an unsigned artifact;
the maintainer signs its final metadata and promotes it into the stable feed.

The [public root](docs/keys/root.pub) certifies the [signing key](docs/keys/signing.pub), whose
[certificate](docs/keys/signing.pub.minisig) and release signatures are public verification
material. See [feed/README.md](feed/README.md). Private keys and passphrases stay outside the
repository and CI. Fresh upstream installations pin the bundled root automatically; custom
repositories or feeds require an explicit `--update-root-key`. Existing pins are preserved.

Prerequisites: `gh`, `minisign`, `openssl`, `jq`, and repository push access. Per-release commands
run from the repository root. Replace `v1.2.3` with the agreed version; retain the staging
directory and exact metadata until public verification is complete.

## Per release

### 1. Reconcile the scope and tag the final commit

List every in-scope PR, including drafts. Confirm its changes are on remote `main`, or record an
explicit exclusion. Check current CI on the final integration; old branch checks are insufficient.
Update version-pinned installation examples in the README and deployment guide before tagging.
Use the exact version requested by the owner. Record the current VPS version separately.

```sh
git fetch origin main
release_tag=v1.2.3
release_commit=$(git rev-parse origin/main)
git tag -a "$release_tag" "$release_commit" -m 'User-facing release notes describing what changes.'
git push origin "$release_tag"
```

The tag message becomes the GitHub release body and the notes shown to the person pressing
Apply. A published tag and its signed assets are immutable; subsequent changes require a new version.

### 2. Wait for the draft and verify the artifact

The tag workflow runs lint, formatting, typecheck, tests and build; stamps the daemon version;
assembles the runnable source tree, prebuilt PWA and dependencies; and creates a draft containing
the artifact and `release.json`. Inspect the workflow for this exact tag and wait for success.

```sh
release_dir=$(mktemp -d "${TMPDIR:-/tmp}/veduta-release.${release_tag}.XXXXXX")
gh release download "$release_tag" --pattern release.json --dir "$release_dir"
gh release download "$release_tag" --pattern "veduta-${release_tag}-linux.tar.gz" --dir "$release_dir"
jq '{version, artifactName, artifactUrl, sha256, dataVersion}' "$release_dir/release.json"
shasum -a 256 "$release_dir/veduta-${release_tag}-linux.tar.gz"
```

Confirm version, artifact name, hash, signed sizes and source provenance against the downloaded
artifact and tagged commit. The upstream artifact URL must address this repository's matching
GitHub release asset over HTTPS. Verify expected `dataVersion` and Node requirements as well.
A changed manifest or rebuilt artifact invalidates earlier verification.

The artifact includes x64 and arm64 dependencies, but signed Node runtime metadata currently
covers **Linux x64 only**. An arm64 runtime download fails exact size/hash verification;
[issue #44](https://github.com/Ic3b3rg/veduta/issues/44) tracks this limitation. Do not present
arm64 self-update as verified support.

### 3. Sign the final bytes

Prepare and verify the final manifest before asking the key holder to run:

```sh
deploy/release.sh sign "$release_dir/release.json" --key ~/veduta-keys/signing.key
```

Minisign prompts for the passphrase in the key holder's terminal. For a handoff to another
terminal, provide absolute paths, not variables defined only in the agent's shell. Wait for
`release.json.minisig`, then verify it against those exact metadata bytes and the trusted public
key before upload. A confirmation message alone does not prove that the file exists.

```sh
minisign -Vm "$release_dir/release.json" -p docs/keys/signing.pub
```

The trusted comment must equal the metadata's `artifactName`. Keep the signed file byte for
byte: reformatting or reserializing it requires a new signature. Never request a passphrase in chat.

### 4. Publish and test the public artifact

```sh
gh release upload "$release_tag" "$release_dir/release.json.minisig"
gh release edit "$release_tag" --draft=false
```

Download the now-public manifest, signature and artifact independently and verify the chain,
hash and provenance. Boot that artifact in an isolated environment with clean production-profile
data; verify readiness, authentication, PWA serving and the declared version. If `dataVersion`
changed, exercise its supported migration path. Keep the owner's existing installation intact
when they have reserved Apply for their own update test.

### 5. Promote and verify the feed

```sh
deploy/release.sh promote "$release_dir/release.json" "$release_dir/release.json.minisig" \
  --signing-pub docs/keys/signing.pub --signing-pub-sig docs/keys/signing.pub.minisig \
  --out feed/stable.json
deploy/release.sh verify feed/stable.json --root-pub docs/keys/root.pub
```

Promotion preserves the exact signed bytes and verifies `artifactUrl`; an optional
`--artifact-url` may cross-check that URL but cannot override it. It is required only for older
metadata that lacks the field. A valid local signature does not prove public downloadability:
verify the advertised artifact from a second host before offering it to installations.

Commit the feed through a focused PR, wait for required checks, and merge under the existing
release authorization. Verify the feed on remote `main` and its publicly served bytes after merge.
At this point an instance can discover the update; installation still requires Apply.

### 6. Verify the update journey

Use **System → Updates → Check now** and confirm the offered version and notes. If the owner
reserved Apply, let them press it and report installation as pending until the result is observed.
For an authorized end-to-end update test:

1. Record the previous version and known Spaces, Events and facts on a disposable or approved host.
2. Apply the offered release through the PWA.
3. Confirm the new version serves, existing data is retained, the pre-update backup exists under
   `/var/lib/veduta/updates/backups/`, and an `update.outcome` Event records the result.
4. Record the outcome and any untested scenario in the release/PR evidence. Remove temporary
   artifacts and completed worktrees after verification; preserve unrelated unfinished work.

Report these stages separately: merged code, published release, promoted feed, and installed
version. Unstamped source checkouts report the `0.0.0` baseline in health and Updates; identify
those builds by deployed commit rather than presenting that baseline as a signed release version.

## Rehearse with disposable keys

On the machine hosting a disposable [Local VPS](deploy/local-vps.md) instance:

```sh
pnpm --filter @veduta/daemon exec tsx ../../scripts/rehearse-update.ts \
  --base-dir ~/.veduta-local-vps --version 0.0.1
```

This stages a release, creates a throwaway two-tier chain and serves a loopback feed, including
the cross-host artifact redirect used by real GitHub downloads. Restart the disposable daemon to
load its new pinning, then exercise Check now and Apply. The same transaction, backup, health
check and rollback code runs. Restore its intended trust pinning before discarding the rehearsal
keys and staging directory. Never replace a live installation's trust root for this test.

## One-time key ceremony

For a new trust root, use a trusted offline machine and a private directory outside every
checkout. This is a one-time operation; existing releases reuse their established trust root.

```sh
umask 077
key_dir="$HOME/veduta-keys"
mkdir -p "$key_dir"
minisign -G -p "$key_dir/root.pub" -s "$key_dir/root.key"
```

Keep a verified recoverable offline copy of `root.key`; it certifies signing keys and is not
needed for routine releases. Publish only `root.pub`. Generate the daily signing key, keep its
private half in secure storage, and certify its public half with the offline root:

```sh
minisign -G -p "$key_dir/signing.pub" -s "$key_dir/signing.key"
minisign -S -s "$key_dir/root.key" -m "$key_dir/signing.pub" -t 'signing.pub'
```

The certificate's trusted comment must be exactly `signing.pub`. Publish `signing.pub` and
`signing.pub.minisig` alongside the root. The upstream installer reads the bundled root from the
pinned checkout; forks supply their own trust anchor explicitly. Existing installations pin
`/etc/veduta/update.json`, which is root-owned and never silently replaced by a release.

## Key-loss recovery

- **Signing key lost:** generate a new pair, certify it with the same offline root using the
  literal trusted comment `signing.pub`, and promote the next release with the new certificate.
  Existing instances verify the chain from their unchanged root and need no manual re-trust.
- **Root key lost with no recovery copy:** establish a new root and explicitly re-pin every
  installation that should trust it. This requires an intentional root-owned configuration
  change; an update signed by a different root cannot authorize its own replacement.

## Verify provenance

```sh
gh attestation verify "$release_dir/veduta-${release_tag}-linux.tar.gz" --owner Ic3b3rg
```

The GitHub attestation establishes the workflow and source commit that built the artifact.
Minisign establishes the maintainer's intent to publish those bytes. Neither replaces the other.
