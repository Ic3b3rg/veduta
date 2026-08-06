# Signed self-update: prebuilt releases, a supervisor wrapper, and automatic data rollback

Veduta updates itself the way it does everything else: discovery is a **visible Automation**
(never a hidden cron), application is a **one-tap approval** from the PWA (an update is an L2-class
action on the platform itself, never silent), and failure is handled by the machine, not the user.
The design is grounded in a survey of Home Assistant, Syncthing, Tailscale and Gitea
([ref. 08](../references/08-self-update-mechanisms.md)); the one place Veduta deliberately goes
beyond all of them is **automatic data rollback** — no surveyed system restores data when an
update fails, and every one of them documents the resulting "backup restore is the only
downgrade" trap. Veduta's daemon is down during its own update window, so no new user data can
appear between backup and failure: restoring the pre-update backup on rollback is lossless _by
construction_, and therefore safe to automate.

Status: accepted (issue #43 is the implementation)

## The decisions

1. **Check automatically, apply on consent.** A daily, user-visible, switchable Automation polls
   the update feed; a new release surfaces as a Surface (version, release notes, whether data
   migrates) with a one-tap apply. Never unattended by default, never SSH-required.
2. **Prebuilt signed artifacts, not rebuilds.** CI builds `veduta-vX.Y.Z.tar.gz` (dist +
   resolved node_modules; no native deps). Updating means download + verify + untar into
   `releases/vX.Y.Z/` and flipping a `current` symlink — atomic by construction, seconds not
   minutes, and the npm registry is out of the trust path at update time. This closes
   SECURITY.md §6 ("signed updates"), deferred since issue #19.
3. **Two data regimes** (the `freshness` boot crash of 2026-08-04 is the motivating incident:
   pre-issue-28 surface-event rows met a strict parser and killed the daemon):
   - _Append-only and truth files_ (Event log JSONL, FACTS, USER/SOUL) are **never rewritten**
     (ADR-0003/ADR-0006). Readers stay tolerant forever, enforced by a fixture corpus test:
     every format ever written in production must parse in every future version.
   - _Derived and sqlite stores_ carry a `dataVersion` marker in the data root and migrate
     **forward-only**, run by the updater after the backup and before the symlink flip.
     Disposable stores (the hybrid index, ADR-0011) are rebuilt, not migrated. No lazy runtime
     migrations: the new daemon refuses to boot on an unexpected `dataVersion`.
4. **Automatic full rollback.** The update sequence is a recoverable on-disk transaction
   (`backup done → migrated → switched`): a crash at any point is resumed or reverted on the
   next start — the old binary is never left running on a migrated schema (the Gitea trap,
   ref. 08 §4). If the new daemon fails its health check, the wrapper flips the symlink back,
   restores the pre-update backup, preserves the failed release's log, restarts the old
   version, and tells the user. The health check is deep, not liveness: API up, every store
   opens, Spaces list, and a surface-event replay from cursor zero — the exact path the
   `freshness` crash killed (the Home Assistant bar, ref. 08 §1).
5. **The executor is a supervisor wrapper.** systemd's `ExecStart` runs a stable
   `/opt/veduta/bin/veduta-run` (outside `releases/`, so a broken release can't break its own
   rescuer): if an update marker exists it runs the whole transaction, then `exec`s the daemon
   from `current/`. The daemon requests an update by writing the marker and exiting with a
   dedicated nonzero code — `Restart=on-failure` restarts it into the wrapper. Same
   monitor-process pattern as Syncthing and the HA Supervisor (ref. 08), same exit-code idiom
   as the onboarding wizard, no new privileges, one unit. The wrapper updates _itself_ last,
   only after a successful health check.
6. **A gated feed, not the raw releases list.** Discovery reads a small `stable.json` the
   maintainer promotes releases into after they have soaked (server-side gating is the
   cheapest way to make rollback rare — Tailscale's practice, ref. 08 §3). The manifest
   declares the artifact hash, the required `dataVersion` migration span, and the required
   Node version. Stable channel only in v1. Feed hosts join the egress allowlist like any
   other tool's domains (SECURITY.md §3.4); release notes enter the system as
   `untrusted:update-feed` data, never as instructions.
7. **Two-tier minisign signing.** An offline **root** key (paper, used once) signs the daily
   **signing** key; the signing key signs `artifact name + contents` (the Syncthing binding,
   ref. 08 §2). The wrapper verifies the chain with two `minisign -V` calls. Losing the daily
   key is recovered by the root without touching any installed instance; losing the laptop is
   a non-event (the key lives in the password manager, the machine is a cache). Feed URL and
   root pubkey are **pinned at install time** with upstream defaults — forks get their own
   update channel by pinning their own, with zero source patches. CI additionally publishes a
   GitHub artifact attestation so anyone can verify the signed bytes came from the public
   source at the tagged commit — essential for an open-source trust story. The ceremony is
   documented publicly in `RELEASING.md`; the manifest carries a key id so rotation needs no
   format change.
8. **Retention and guardrails.** `current` + two previous releases (pruned only after a
   successful update); the last three pre-update backups, tagged and pruned via the existing
   `pruneBackups`; a free-disk-space check before anything starts.
9. **Scope: the whole system, honestly bounded.** The Node runtime is part of the updatable
   system: the manifest pins it, the updater installs missing versions into a shared
   `runtimes/` dir with the installer's existing SHASUMS256 verification, and each release
   references its runtime — `current/` is always complete and coherent. The host OS is
   explicitly out of scope (Debian/Ubuntu + systemd is the declared reference platform; OS
   patching belongs to the operator).

## Considered options

- **Unattended auto-apply by default**: rejected — an update is an action on the platform;
  Veduta's whole trust model is approval-first. May become an opt-in channel later.
- **Update by re-running the installer (git + rebuild on the VPS)**: rejected — minutes-long
  windows on small hosts, the whole npm registry in the trust path at update time, and
  nothing immutable to sign.
- **Down-migrations for rollback**: rejected — untested reverse migrations are worse than
  none; the pre-update backup is the downgrade path, and automating its restore is safe here
  because the daemon is down during the window.
- **CI-held signing key**: rejected — repo compromise would equal key compromise, degrading
  the signature to a checksum. Keyless CI signing (Sigstore) alone was also rejected as the
  wrapper-facing root of trust: the verifier is not POSIX-script material and the trust is
  half-circular for artifacts served by GitHub; it complements as attestation instead.
- **Single signing key**: rejected after the "what if I lose the laptop" analysis — recovery
  would require every instance to re-trust manually; the two-tier ceremony costs ten minutes
  once.

## Amendments (issue #43 implementation)

Three deltas surfaced while implementing this ADR against the real repository and survived an
adversarial design review; the original decisions' goals are unchanged.

1. **The artifact is a runnable tree, not an emitted `dist`.** `veduta-vX.Y.Z-linux.tar.gz`
   contains the checkout at the tag (sources and configs), the prebuilt PWA `dist`, and the fully
   resolved `node_modules`; the daemon runs from it via `tsx`, exactly as the installer-deployed
   VPS profile runs today. Emitting JS is blocked by the repo's own compiler posture
   (`verbatimModuleSyntax` + in-repo `.ts`-extension imports + `noEmit`), and what decision 2
   actually buys — download + verify + untar + symlink flip in seconds, with the npm registry out
   of the trust path at update time — holds for a runnable tree just as well. Portability across
   the two supported server architectures is handled at release-build time with pnpm
   `supportedArchitectures` (`os: [linux]`, `cpu: [x64, arm64]`), so one artifact carries both
   native binary sets and the platform is part of the signed artifact name.
2. **Verification is minisign-compatible TypeScript, not `minisign -V` subprocess calls.** The
   transaction executor is TypeScript (that is what makes every acceptance criterion testable on
   any dev machine, with no `apt`/`brew` runtime dependency), so the verifier is a small
   `node:crypto` implementation (Ed25519 + BLAKE2b-512, minisign's prehashed `ED` format) proven
   against **committed golden fixtures generated with the real minisign CLI**. The formats stay
   fully minisign-interoperable and the maintainer ceremony in `RELEASING.md` keeps using the
   real minisign binary. What gets signed is stronger than the original wording: the signing key
   signs the canonical `release.json` bytes — version, artifact name, SHA-256, artifact/unpacked
   sizes and entry count, required `dataVersion`, required Node version and its download sizes —
   with the artifact name in the trusted comment. That closes the unsigned-manifest downgrade
   hole (a feed cannot re-advertise an old artifact under a fabricated version), and the updater
   independently refuses non-monotonic version/dataVersion offers regardless of feed contents.
3. **Layout lives in `/var/lib/veduta/updates/`; the trust anchors are root-owned.** The unit
   runs everything as `veduta` (decision 5: no new privileges, one unit), so the service user
   necessarily owns the code it updates — the same posture as Syncthing and Tailscale, stated
   here honestly: a daemon-RCE attacker can already persist as the `veduta` account, and the
   sandbox still confines them to it. The update layout (`releases/` with the `current` symlink
   inside it, `runtimes/`, `bin/veduta-run`, `state/`, `backups/`) therefore sits under the
   already-writable `/var/lib/veduta`, outside the root-owned git checkout (which installer
   reruns `git clean`). What a compromised daemon must **not** be able to do is repoint the
   update channel: the feed URL + root public key pinning lives in root-owned
   `/etc/veduta/update.json`, written only by the installer (fork-overridable via installer
   flags). The wrapper self-updates last, atomically (temp + fsync + rename), only after the new
   release has passed the full health check.

## Amendments (issue #46 implementation)

Testing decision 7 (the artifact download) against a real, published GitHub release rather than
a synthetic fixture broke it outright: nothing ever came down. What follows came out of tracing why
and fixing it; none of it changes what issue #43 built, only where the trust boundary around the
artifact fetch actually sits.

1. **GitHub releases were unfetchable, full stop, and the ADR's own pin was the cause.**
   `stageRelease` passed the pinned _feed_ host as the artifact download's allowed host, and the
   fetch transport refused any redirect that changed host. Driving the production fetch code at
   the real published v0.0.1 asset produced exactly this:

   ```
   REFUSED: refusing a cross-host redirect: github.com -> release-assets.githubusercontent.com
   ```

   GitHub's release-asset redirect lands on a `release-assets.githubusercontent.com` URL whose
   query string carries a short-lived signed credential (`sig=`, `jwt=`). No release hosted the
   way decision 2 describes — "CI builds `veduta-vX.Y.Z.tar.gz`" attached to a GitHub release —
   could ever have been installed by decision 5's wrapper as written. The gap was invisible until
   something actually dialed `github.com` for real.

2. **The fix: `artifactUrl` joins the signed release metadata, and the host pin lifts only when
   it is present.** `ReleaseMetadataSchema` (`packages/protocol/src/update.ts`) gains an optional
   `artifactUrl`. Optional so a release signed before the field existed still parses — but the
   updater does not simply fall back and forget when it is absent; the two behaviors are mutually
   exclusive and the absent case is exactly the pre-issue-#46 behavior, unchanged:

   | Signed `artifactUrl`    | URL fetched                    | Host pin                         | Cross-host redirects       |
   | ----------------------- | ------------------------------ | -------------------------------- | -------------------------- |
   | present                 | the signed one                 | none                             | allowed, https only        |
   | absent (legacy release) | the manifest's, via the marker | the feed host, exactly as before | refused, exactly as before |

   Nothing is relaxed for a release that cannot prove where its bytes live. The reasoning for why
   this is safe rather than a hole reopened under a different name: `artifactUrl` was previously
   only present in `UpdateManifestSchema` (the feed) and `UpdateMarkerSchema` — both **unsigned**.
   The original host pin was therefore never a defense against a compromised _signing key_ — a
   signing-key holder already controls the bytes the URL points at, so following that URL across
   hosts grants them nothing they lack. It was the only thing standing between a **feed-level**
   attacker (one who can edit `stable.json` but does not hold the signing key) and a fetch target
   of their choosing: replay a genuinely-signed _newer_ release's metadata with a substituted
   `artifactUrl`, and the chain still verifies, monotonicity still passes, the Update Surface
   still offers it, and Apply issues a GET at whatever the attacker put in the manifest — from a
   machine inside a home network. A hash mismatch, discovered only after that GET has already
   fired, cannot un-issue the request. Moving the URL inside the signed bytes closes exactly that
   gap: the party who chooses the fetch target is now the same party who already chooses the
   bytes at that target, for every release built with this field.

   That mismatch is refused twice, in two different processes, on purpose: visibly at check time
   by the daemon (`update-manager.ts`'s `runCheck`, the same failed-check path a bad signature
   takes, regardless of whether the offered version is newer), and again as a fail-safe by the
   process that actually dials the URL (`update-transaction.ts`'s `stageRelease`) — because that
   transaction, not the daemon, is what a marker written by a since-patched or misbehaving daemon
   would otherwise steer unchecked.

3. **What genuinely bounds the residual risk is TLS, not the signature.** Every hop in the fetch
   — the initial URL and every redirect — must be https, and an https-to-http downgrade across a
   redirect is refused (`fetch-policy.ts`'s `resolveRedirect`). A redirect target can therefore
   only be a host that presented a certificate a browser-grade trust store accepts. That is what
   actually stops the attacker the pin was informally imagined to stop: nobody positioned on the
   home LAN, and nobody who can only steer the household's DNS resolver, can redirect this fetch
   anywhere at all — TLS termination, not host allowlisting, is doing that work. Against a
   signing-key holder, the relaxation does add one real capability: an arbitrary-https-target GET
   issued from inside the home network, at a URL the signing key chose. Stated plainly rather
   than minimized: that GET is invisible next to the arbitrary code execution the same key already
   buys by signing whatever bytes it likes into the next release. Pretending the relaxation adds
   meaningful risk on top of that would be theatre.

4. **The feed fetch went the other way, and that was worse.** The _unsigned_ entry point —
   `stable.json` itself — was the loose one: WHATWG `fetch`'s default `redirect: 'follow'` silently
   follows a cross-host hop, and nothing checked for https at all (`UpdatePinningSchema` only
   requires a well-formed URL, so a plain `http://` feed URL parsed and would have been used as
   given). The posture was inverted: the hash-verified artifact fetch was strict about hosts and
   the unsigned feed fetch was not. `fetchCapped` (`update-manager.ts`) now shares
   `fetch-policy.ts`'s rules with the artifact transport: https-or-loopback, `redirect: 'manual'`
   with every hop resolved through the same `resolveRedirect`, same-host hops only (the feed URL
   itself is the pin — it comes from root-owned `update.json`, so there is no separate `pinnedHost`
   parameter here, just "stay on this host"), and one abort budget shared across the whole
   redirect chain rather than one per hop.

5. **Timeouts, which the artifact transport had none of, and a budget shared across a whole
   transaction.** The artifact fetch (`update-ports.ts`) had no connect, idle, or total deadline of
   any kind, and drained a 3xx response body with no size cap while deciding whether to follow it.
   Since the daemon is down for the entire update window (this ADR's core premise), a server that
   accepts the connection and then stalls was not a slow download — it was an outage with no
   timeout to end it. There is now an idle timeout (`DEFAULT_IDLE_TIMEOUT_MS`, 60 s: no bytes for
   that long is a dead transfer on any link that can carry a multi-ten-megabyte artifact) and a
   single total deadline (`FETCH_BUDGET_MS`, 30 minutes) **shared by every download one
   transaction makes** — the artifact, the Node runtime tarball, and its `SHASUMS256.txt` all draw
   down the same budget (`remainingFetchBudgetMs`) rather than each buying its own 30 minutes,
   which would let one slow or hostile host hold an instance offline for the sum of all three.
   Deliberately not done alongside this: no `timeout` was placed around the updater invocation in
   `deploy/veduta-run`. A supervisor hard-killing a migrating updater is survivable — the journal
   makes it resumable, per decision 4 — but which timeout value makes that trade well is its own
   question, not a drive-by alongside a fetch-policy fix; the shared download budget already
   removes the specific stall that motivated raising it.

6. **A journal-derivation hardening the review of this change surfaced, unrelated to the artifact
   URL itself but caught while reading the same code.** The transaction journal stores the
   release metadata twice: `marker.release` holds the exact bytes the signing key signed, and a
   separate `release` field held a parse of them that nothing re-checked once written. The
   transaction now re-derives `release` from `marker.release` and re-runs `verifyReleaseChain`
   every time execution reaches this point, under a guard widened from "only on a fresh start" to
   "on every run that still has staging ahead of it" — so a resume at the `downloaded` or
   `verified` phase, which still re-downloads the artifact, re-verifies the signature chain too.
   Before this, such a resume re-downloaded with no signature check at all _in that run_ — it
   trusted the parse a previous, already-verified run had left behind, which is safe only as long
   as nothing on disk between runs can change that field. Only reachable by whoever can already
   write to the update home, i.e. the `veduta` service account this ADR's Amendment 3 already
   concedes a daemon-RCE attacker can persist as. That matters for a specific sentence:
   `docs/SECURITY.md` §6 summarizes this whole mechanism as releases "checked entirely by the
   updater itself before anything is downloaded or installed." That sentence is not about hashing
   bytes that do not yet exist — it means the offer's signature chain is verified before the
   artifact download begins, in every run of the transaction, including a resumed one. Before this
   amendment it was not quite true for the resumed-at-`downloaded`/`verified` case above; it is
   true now, and this amendment is what makes it true rather than merely asserted.

7. **Alternatives rejected.** An explicit `artifactHost` field in the pinning file, checked
   instead of the full URL: rejected outright, because it does not solve the actual problem —
   `github.com` and `release-assets.githubusercontent.com` are different registrable domains, so
   pinning either one still refuses the other and GitHub-hosted releases remain unfetchable, which
   is the whole defect this amendment exists to fix. Self-hosting artifacts on the feed host, so
   the existing feed-host pin covers the artifact too: rejected as a tax on wherever the feed is
   served from — roughly 63 MB per release, forever, on infrastructure that exists to serve a few
   kilobytes of JSON — and it abandons GitHub Releases' natural home for the build-provenance
   attestation (`actions/attest-build-provenance`, `RELEASING.md` §(e)) for no security benefit,
   since the artifact's integrity already rests on the signed hash, not on its host. A
   `basename(artifactUrl) === artifactName` check as a lighter-weight substitute for signing the
   full URL: rejected as decorative once the URL is inside the signed bytes — an attacker who
   cannot forge the signature already cannot substitute a URL at all, signed or not, so a basename
   check adds a comparison with nothing left for it to catch.

8. **v0.0.1 does not become installable by this change alone.** Its already-signed metadata
   predates the `artifactUrl` field, so a fixed instance offered v0.0.1 still holds it to the
   feed-host pin and still refuses the real GitHub asset — exactly the legacy row of the table in
   Amendment 2, working as designed. `feed/stable.json` is deliberately not committed. A working
   one-tap install of a real GitHub-hosted release needs a v0.0.2 cut after this amendment lands,
   whose CI-built `release.json` carries the signed URL from the start. What this amendment does
   have in hand without that cut: the production fetch path (`fetchChecked`,
   `resolveRedirect`, `assertFetchableUrl`) driven directly at the real published v0.0.1 asset,
   following the real GitHub → `release-assets.githubusercontent.com` redirect end to end, with
   the downloaded bytes' sha256 matching the release's signed value; and the rehearsal harness
   (`scripts/rehearse-update.ts`, `RELEASING.md` §0) performing a real one-tap install across a
   redirect between two loopback hosts, exercising the cross-host hop itself rather than only a
   same-host download.

9. **The two halves of the chain disagreed about which bytes the root signature covers, and only
   a real promotion could show it.** `deploy/release.sh` embeds the signing key's public key file
   into `stable.json` as a JSON string. Its escaper dropped the file's trailing newline and its
   unescaper added one back — a matched pair, correct as long as the script was the only reader.
   It is not: `verifyReleaseChain` (`packages/daemon/src/update/minisign.ts`) verifies the
   manifest's text exactly as given, and cannot know to append a byte nobody told it about.
   `minisign` had signed the file including that newline. So `deploy/release.sh verify` reported
   `OK: full chain verified` — it writes the text back to a file, restoring the byte — while every
   installed instance would have refused the same feed with `bad content signature`. Both halves
   were tested; nothing tested the seam, so both passed while disagreeing. The manifest now carries
   the file's bytes verbatim, and `release-ceremony.test.ts` runs the real ceremony script and
   hands what it wrote to the real verifier, so the two can no longer drift apart silently. Worth
   generalizing: for any signature, the transport must preserve the signed bytes exactly, and the
   test that proves it has to cross the producer/consumer boundary — testing each side against its
   own idea of the bytes is what let this reach a published release.
