# Releasing Veduta

This is the public ceremony behind signed self-update (issue #43,
[docs/adr/0013-signed-self-update.md](docs/adr/0013-signed-self-update.md), especially its
"Amendments" section, which is authoritative for the artifact format, what gets signed, and
the on-disk layout). Anyone can read this file and reproduce the verification steps
themselves; nothing here is secret except the two private keys, and even those are recoverable
without asking any installed instance to re-trust anything (see "Key-loss recovery" below).

The trust chain is two-tier minisign: an offline **root** key certifies a **signing** key once;
the signing key signs every release's metadata. CI ([.github/workflows/release.yml](.github/workflows/release.yml))
builds and attests releases but **never holds either private key** — signing and feed
promotion are local maintainer steps, run with [deploy/release.sh](deploy/release.sh) against
the real `minisign` CLI.

## Prerequisites

- [`minisign`](https://jedisct1.github.io/minisign/) (`brew install minisign` /
  `apt install minisign`).
- `openssl` (for `deploy/release.sh`'s base64 handling — present on virtually every machine
  already).

## (a) One-time: the key ceremony

Do this once, before the first signed release ever exists.

1. **Generate the root keypair, offline, on a machine you trust and can disconnect:**

   ```sh
   minisign -G -p root.pub -s root.key
   ```

   Print `root.key`'s contents (or the QR code minisign can generate for it) and store the
   paper copy somewhere durable and physically secure — a safe, a safety deposit box. Delete
   the file from the machine that generated it once the paper copy exists. This key is used
   exactly twice in this key's lifetime under normal operation: once now, and once again only
   if the signing key is ever lost (see (c) below).

2. **Publish `root.pub`.** It has no secrecy requirement — commit it to the repository (e.g.
   `docs/keys/root.pub`) and/or publish it on the project's website. Every installed instance
   pins this exact public key at install time
   (`/etc/veduta/update.json`, per the ADR's Amendments §3); it is the one thing that can never
   be silently swapped without re-running the installer.

3. **Generate the signing keypair**, on any machine, and store its secret key (`signing.key`)
   in a password manager — this key is used routinely (every release), so it needs to be
   reachable, unlike the root key:

   ```sh
   minisign -G -p signing.pub -s signing.key
   ```

4. **Certify the signing key with the root key.** The trusted comment must be the literal
   string `signing.pub` — the verifier
   (`packages/daemon/src/update/minisign.ts`, `verifyReleaseChain`) rejects any other value:

   ```sh
   minisign -S -s root.key -m signing.pub -t 'signing.pub'
   ```

   This produces `signing.pub.minisig`. Commit `signing.pub` and `signing.pub.minisig`
   alongside `root.pub` — they are both public, and `deploy/release.sh promote` needs them on
   disk for every release.

## (b) Per release

1. **Tag and push:**

   ```sh
   git tag -a v1.2.3 -m 'Release notes for v1.2.3...'
   git push origin v1.2.3
   ```

   The tag message becomes the release's `notes` field (and the GitHub release body) verbatim
   — write it for the person tapping "Apply" in the Update Surface, not for other maintainers.

2. **CI builds a draft release.** `.github/workflows/release.yml` runs the full gate
   (lint/format/typecheck/test/build) against the tagged commit, assembles
   `veduta-v1.2.3-linux.tar.gz` (the runnable tree: sources, configs, the prebuilt PWA `dist`,
   and `node_modules` resolved for both `linux-x64` and `linux-arm64` — one artifact serves
   both server architectures), computes the unsigned `release.json`, attests build provenance
   (`actions/attest-build-provenance`), and opens a **draft** GitHub release with both files
   attached. Nothing is signed yet, and nothing is publicly reachable through the update feed
   yet — a draft release is invisible to `stable.json` readers by construction.

3. **Download `release.json` from the draft release** and sign it with the signing key:

   ```sh
   deploy/release.sh sign release.json --key signing.key
   ```

   This runs the real `minisign -S`, prompting for the signing key's passphrase on your
   terminal — never passed as an argument, never echoed. It produces `release.json.minisig`,
   with the trusted comment set to the release's own `artifactName` (the binding that stops a
   feed from ever re-advertising an old, still-validly-signed release under a different name).

4. **Upload `release.json.minisig`** as an additional asset on the same draft release, then
   **publish the draft** (make it a real, non-draft GitHub release). At this point the release
   is signed and downloadable by URL, but still not offered to any installed instance — nothing
   reads it yet, because it is not yet in `feed/stable.json`.

5. **Let it soak.** Install it yourself somewhere low-stakes (the Local VPS profile, or a
   spare VPS) via the artifact URL and confirm it boots, serves, and — if `dataVersion`
   changed — migrates cleanly. This is the gate that makes rollback rare in practice (a soaked
   release is a release nobody has been burned by yet); there is no fixed soak duration, use
   judgment.

6. **Promote it into the feed:**

   ```sh
   deploy/release.sh promote release.json release.json.minisig \
     --signing-pub signing.pub --signing-pub-sig signing.pub.minisig \
     --out feed/stable.json \
     --artifact-url https://github.com/Ic3b3rg/veduta/releases/download/v1.2.3/veduta-v1.2.3-linux.tar.gz
   ```

   This composes `feed/stable.json` (schema: `UpdateManifestSchema`,
   `packages/protocol/src/update.ts`) from the exact signed bytes — never re-serialized, so
   `releaseSig` verifies against the identical bytes that were signed.

7. **Pre-flight the result**, then commit it:

   ```sh
   deploy/release.sh verify feed/stable.json --root-pub root.pub
   git add feed/stable.json
   git commit -m 'Promote v1.2.3 to the stable update feed'
   ```

   `verify` re-derives the chain with the real `minisign` CLI (root → signing key cert →
   release metadata) — a second, independent check of exactly what every installed instance's
   TypeScript verifier (`minisign.ts`) will also check, before this file becomes the thing
   that offers the release to every daemon polling the feed.

## (c) Key-loss recovery (AC7)

**Losing the signing key** (laptop stolen, password manager entry deleted, whatever) is
recoverable without touching any already-installed instance:

1. Generate a new signing keypair: `minisign -G -p signing2.pub -s signing2.key`.
2. Certify it with the root key exactly as in step (a)4:
   `minisign -S -s root.key -m signing2.pub -t 'signing.pub'`.
3. The next `deploy/release.sh promote` run, pointed at the new `signing2.pub` /
   `signing2.pub.minisig`, writes a `feed/stable.json` whose `signingKey` block now carries the
   new certificate.
4. Every already-installed instance accepts it with **zero manual re-trust**: its root public
   key never changed, and `verifyReleaseChain` re-derives trust from the root on every check,
   not from a cached signing key. The old signing key can simply be abandoned (or explicitly
   revoked out-of-band, e.g. announced on the project's channels) — there is nothing to rotate
   on the installed side.

**Losing the root key** is the one disaster this two-tier scheme cannot absorb — by design, the
root key's entire job is to be the thing nothing else can override. If it is truly gone (paper
destroyed, no copy anywhere), recovery requires **re-pinning at install time**: every instance
that should trust a new root key needs its `/etc/veduta/update.json` rewritten (a rerun of
`deploy/install.sh` with new `--update-root-key`/`--update-feed` values, or a manual root-owned
edit) before it will accept anything signed under the new root. This is stated honestly rather
than hidden: it is the cost of the root key never being reachable over the network in the first
place, which is exactly what keeps a repo or CI compromise from ever becoming a signing
compromise.

## (d) Manual smoke checklist (NOT CI-gated)

A real GitHub-released update, exercised against an actual host — this is deliberately a manual
exercise; it spends real infrastructure and cannot run inside CI:

1. Install a VPS (or the Local VPS profile) at the previous stable release.
2. Confirm pre-update state: create a Space, send a chat message, note the Spaces/Events/facts
   present.
3. Promote the new release into `feed/stable.json` as in (b)6-7, and push the commit (or, for
   a local rehearsal, point the instance's pinning at a locally-served copy of the feed).
4. Wait for (or manually trigger) the daily "Check for updates" Automation; confirm the Update
   Surface offers the new version.
5. Tap Apply. Confirm: the new version serves afterward, the pre-update Spaces/Events/facts are
   all still present, a pre-update backup exists under `/var/lib/veduta/updates/backups/`, and
   the Space's Event log records an `update.outcome` event.
6. Record the outcome (date, versions, host) in the release's notes or the project's
   deployment log.

## (e) Verifying provenance

Anyone can confirm a downloaded artifact was actually built by this project's own CI from the
tagged public source, independent of the minisign chain:

```sh
gh attestation verify veduta-v1.2.3-linux.tar.gz --owner Ic3b3rg
```

This checks the `actions/attest-build-provenance` attestation `release.yml` generates for every
build — it proves _provenance_ (which workflow, which commit, which repo built this exact file)
and is a complement to the minisign chain (which proves _maintainer intent to release this_),
not a replacement for it: a compromised repo could still produce an attested-but-malicious
build, which is exactly why CI never holds the signing key.
