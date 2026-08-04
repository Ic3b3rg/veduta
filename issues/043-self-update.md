# 043 — Signed self-update: one tap from the Home, zero data loss

## Context

Updating a deployed Veduta today means SSH plus a re-run of the installer — and nothing protects
the data across the jump: there is no schema versioning, no migration step, and readers of
persisted state can be strict enough to kill the boot (the 2026-08-04 incident: surface-event
rows written before issue #28 lacked `freshness`, and the gateway's hello replay crashed the
daemon — data intact, platform dead). SECURITY.md §6's "signed updates" has been an explicit
debt since issue #19 deferred release-signature verification.

The design is settled in [ADR-0013](../docs/adr/0013-signed-self-update.md), grounded in the
survey of Home Assistant, Syncthing, Tailscale and Gitea
([docs/references/08-self-update-mechanisms.md](../docs/references/08-self-update-mechanisms.md)).
Existing pieces this issue composes rather than reinvents: `createBackup`/`restoreBackup`/
`pruneBackups` (backup.ts), the installer's SHA-verified pinned-Node install, the
runner/exit-code restart idiom (Local VPS runner, onboarding wizard), the scheduler's visible
Automations, the egress allowlist, and the Surface/notification discipline.

## Goal

From the Home: a badge says a new version exists; one tap later the platform is on it — backup
taken, data migrated, health-checked — and if anything fails, the platform is back on the old
version with the old data, telling the user honestly what happened. No SSH, no data loss, ever.

## Tasks

- **Release pipeline**: CI builds `veduta-vX.Y.Z.tar.gz` (dist + node_modules) with a GitHub
  artifact attestation; a local `release` script verifies the build, signs
  `name + contents` with the **signing** minisign key, uploads signature, and (separately)
  promotes the release into the gated `stable.json` feed. Two-tier key ceremony (offline root
  signs the signing key) documented in a public `RELEASING.md`. Manifest fields: version,
  artifact URL + SHA256, minisign signature, key id, required `dataVersion`, required Node
  version, release-notes text.
- **Layout + wrapper**: `releases/vX.Y.Z/` + `current` symlink + shared `runtimes/node-*/`;
  `bin/veduta-run` as the systemd `ExecStart` — on an update marker it runs the recoverable
  transaction (disk-space guardrail → download → verify chain root→signing→artifact → install
  pinned Node if missing → `createBackup` (pre-update tag) → forward-only migrations →
  symlink flip → start → deep health check → prune), resuming or reverting any interrupted
  state on restart, never leaving old code on migrated data. Rollback restores the backup,
  preserves the failed release's log, and restarts the previous version. The wrapper updates
  itself last, only after a passed health check. Installer pins feed URL + root pubkey
  (upstream defaults, fork-overridable) and installs the wrapper + updated unit file.
- **Data versioning**: a `dataVersion` marker in the data root; a migrations module (one
  forward-only step per bump, sqlite/derived stores only — disposable indexes rebuild); boot
  refuses a mismatched `dataVersion` with a plain error. A **fixture corpus test** freezes
  every format ever written to append-only files (starting with pre-`freshness` surface-event
  rows) so tolerant readers can never regress into a boot crash again.
- **Deep health check**: a daemon self-check mode/endpoint the wrapper drives — API up, every
  store opens, Spaces list, surface-event replay from cursor zero, `dataVersion` matches.
- **Discovery + UI**: a daily visible Automation ("Check for updates", switchable, manual
  "check now") fetching `stable.json` through the egress allowlist (feed hosts declared);
  release notes ingested as `untrusted:update-feed` data. An update Surface (current →
  available version, notes, "migrates your data — backup automatic" when the manifest says
  so) whose apply action writes the marker and exits with the dedicated code; progress and
  outcome (success, or rollback with reason) reported back into the Surface and as a
  notification.
- **Retention**: keep `current` + 2 releases and 3 pre-update backups; prune only after a
  successful update; prune orphaned runtimes.
- **Docs**: `RELEASING.md`, deploy/README + local-vps.md updates, SECURITY.md §6 marked
  satisfied.

## Acceptance criteria

- **AC1 — happy path, e2e**: on the Local VPS profile with a local fake feed and a throwaway
  test keypair: the Automation discovers a staged release, the Surface offers it, one tap
  updates — and afterwards the new version serves, pre-update Spaces/Events/facts/sessions
  are intact, the pre-update backup exists, and the Space log records the update outcome.
- **AC2 — bad signature**: a feed offering an artifact whose signature does not verify (wrong
  key, or name/contents mismatch) is refused outright: no backup, no switch, an honest error
  in the Surface, old version untouched.
- **AC3 — failed health check rolls back**: a staged release whose daemon fails the deep
  check (e.g. seeded old-format rows + a deliberately strict reader) triggers automatic
  rollback: old version serving, data restored from the pre-update backup, failed release's
  log preserved on disk, user notified — all without operator input.
- **AC4 — interrupted transaction**: killing the wrapper between migration and symlink flip,
  and between flip and health check, leaves the system recoverable: the next start resumes or
  reverts; at no point does the old binary run against migrated stores.
- **AC5 — fixture corpus**: the append-only fixture test fails if any historical format stops
  parsing (proven by mutation: strip the tolerance for `freshness`-less rows and the suite
  goes red).
- **AC6 — runtime jump**: a staged release whose manifest pins a different Node version
  installs it (SHA-verified) and serves from it; a tampered Node download is refused.
- **AC7 — key custody**: losing the signing key is recoverable — a root-signed replacement
  signing key in the feed is accepted by an already-installed wrapper with no manual re-trust
  (test with throwaway root); an artifact signed by an un-rooted key is refused.
- **AC8 — space guardrail**: with insufficient free disk, the update refuses before touching
  anything, with a clear message.
- Every criterion driven by tests (e2e for AC1-3, harness/unit for the rest); manual smoke of
  a real GitHub-released update documented, not CI-gated.

## Dependencies

019, 023; ADR-0013; docs/references/08-self-update-mechanisms.md
