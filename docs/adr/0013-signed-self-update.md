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
