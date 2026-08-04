# Research 08 — Self-update mechanisms in self-hosted platforms

> Conducted on 2026-08-04 against primary sources (official docs, source repos). Informs the
> design of Veduta's self-update pipeline: signed prebuilt artifacts, `releases/` dir +
> `current` symlink, backup-before-update, forward-only sqlite migrations pre-switch, deep
> health check with automatic full rollback, ExecStart supervisor wrapper, in-app discovery.

How Home Assistant, Syncthing, Tailscale, and Gitea discover, verify, apply, and roll back
updates — and what each pattern implies for a single-user daemon on a VPS under systemd.

## Comparison table

| Axis                | Home Assistant                                                        | Syncthing                                                    | Tailscale                                                       | Gitea                                    |
| ------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------- |
| Discovery           | Supervisor polls `version.home-assistant.io/{channel}.json`           | Binary polls `upgrades.syncthing.net/meta.json`              | Control plane gates rollout; client/package manager pulls       | Manual (operator-driven)                 |
| Verification        | HTTPS + channel match; no artifact signature observed in update path  | Embedded Ed25519-style pubkey; sig binds archive name+binary | Two-tier: offline root keys → rotatable signing keys → files    | Not covered in upgrade docs (unverified) |
| Backup vs migration | Optional partial backup pre-update; DB migrates on new-version boot   | No data backup; old binary kept as `.old`                    | N/A (no server-side state)                                      | Mandatory manual backup; migrate on boot |
| Executor            | External Supervisor container; OS via RAUC A/B slots                  | Process replaces own binary; monitor process restarts it     | Package manager / app store / `clientupdate`, control-triggered | Operator replaces binary                 |
| Rollback            | Automatic: health check fails → reinstall previous image; OS A/B slot | None automatic; crash-loop detection only; manual `.old`     | None; mitigated by server-side staged rollout                   | Restore backup (DB migrations one-way)   |

## Home Assistant

**Discovery.** The Supervisor polls a static version endpoint: `URL_HASSIO_VERSION =
"https://version.home-assistant.io/{channel}.json"` with channels `stable`/`beta`/`dev`
(`UpdateChannel` enum in [supervisor/const.py](https://github.com/home-assistant/supervisor/blob/main/supervisor/updater.py);
constant in [const.py](https://github.com/home-assistant/supervisor/blob/main/supervisor/const.py)).
The JSON (published from [home-assistant/version](https://github.com/home-assistant/version):
`stable.json`, `beta.json`, `dev.json`) carries versions for Core, Supervisor, OS (per board,
plus an upgrade map), plugin add-ons, Docker image URLs, and OTA URLs. The updater rejects
payloads whose `channel` field does not match the active channel. In the UI, pending updates
surface as **Update entities** (`installed_version`, `latest_version`, features `INSTALL`,
`BACKUP`, `PROGRESS`, `SPECIFIC_VERSION`, `RELEASE_NOTES`) listed under Settings → System →
Updates, with a manual "Check for updates" action
([update entity docs](https://developers.home-assistant.io/docs/core/entity/update),
[common tasks — OS](https://www.home-assistant.io/common-tasks/os/)).

**Verification.** The version JSON is fetched over HTTPS and validated only for channel
consistency ([updater.py](https://github.com/home-assistant/supervisor/blob/main/supervisor/updater.py));
artifacts are Docker images pulled from the registry, so integrity rests on registry TLS and
image references. No separate artifact-signature verification was observed in the update path
(**unverified** whether any additional image-content verification exists elsewhere in the
Supervisor).

**Backup/migration ordering.** The update dialog exposes a backup toggle; the entity model
passes `backup: bool` into `async_install(version, backup)`
([update entity docs](https://developers.home-assistant.io/docs/core/entity/update)). When set,
the Supervisor runs `do_backup_partial(name=f"core_{current_version}", homeassistant=True, ...)`
**before** pulling the new image
([supervisor/homeassistant/core.py](https://github.com/home-assistant/supervisor/blob/main/supervisor/homeassistant/core.py)).
The user-set preference acts as a default, changeable per update
([common tasks — general](https://www.home-assistant.io/common-tasks/general/)); whether it
defaults to on for fresh installs is not stated in the docs (**unverified**). DB schema
migration is **migrate-after-switch**: the recorder migrates at startup of the _new_ Core.
Non-live migrations block startup ("Home Assistant will not start until the upgrade is
completed... may take several hours"); live migrations — possible only from schema version ≥ 48
(HA 2025.1) when no offline data migration is pending — run in the background while HA serves
([recorder/migration.py](https://github.com/home-assistant/core/blob/dev/homeassistant/components/recorder/migration.py)).

**Executor.** An external, always-running orchestrator: the Supervisor pulls the new Core
image and restarts the Core container while itself staying up
([Supervisor docs](https://developers.home-assistant.io/docs/supervisor/)). OS updates use
[RAUC](https://rauc.io/) with dual boot slots: "On each Operating System update, the other boot
slot is updated and reboot is triggered"
([HAOS README](https://github.com/home-assistant/operating-system),
[common tasks — OS](https://www.home-assistant.io/common-tasks/os/)).

**Rollback.** The Supervisor advertises "Update Home Assistant Core. Automatically roll back
if the update fails" ([Supervisor docs](https://developers.home-assistant.io/docs/supervisor/)).
Failure is a **deep health check**, not just process liveness: (1) Core API must respond after
start; (2) required components `http`, `frontend`, `websocket_api` must be loaded; (3) a
`verify_frontend` probe exercises HTTP/WebSocket endpoints as an external client would. On
failure with a known `rollback_version`, it logs `"HomeAssistant update failed -> rollback!"`,
reinstalls the previous image, and preserves the failed run's log as
`home-assistant-rollback.log`
([supervisor/homeassistant/core.py](https://github.com/home-assistant/supervisor/blob/main/supervisor/homeassistant/core.py)).
For the OS, a failed boot automatically falls back to the previous slot; `ha os boot-slot other`
switches manually ([common tasks — OS](https://www.home-assistant.io/common-tasks/os/)).
Note the gap: image rollback does not un-migrate the recorder DB — the documented downgrade
path for Core is a partial backup restore.

**Lesson for Veduta:** the closest production validation of Veduta's exact plan — external
executor + multi-layer post-start health check (API up, critical subsystems loaded, endpoint
probed as a client) + automatic reinstall of the previous version + failed-run log preservation
— and a demonstration that binary rollback alone cannot undo a DB migration, which is why the
backup restore must be part of the automatic rollback.

## Syncthing

**Discovery.** The running binary polls a releases metadata URL, default
`https://upgrades.syncthing.net/meta.json`
([`ReleasesURL` default in lib/config/optionsconfiguration.go](https://github.com/syncthing/syncthing/blob/main/lib/config/optionsconfiguration.go)),
overridable for nightlies (`https://upgrades.syncthing.net/nightly.json`)
([release docs](https://docs.syncthing.net/users/releases.html)). Channel choice
(stable / stable+candidates) is a settings dropdown; `SelectLatestRelease` sorts by version,
skips pre-releases unless allowed, filters by platform, and prefers an acceptable minor upgrade
over a newer major
([lib/upgrade/upgrade_supported.go](https://github.com/syncthing/syncthing/blob/main/lib/upgrade/upgrade_supported.go)).
Checks are throttled (`upgradeCheckInterval` 5 min; per-version retry 1 h)
([cmd/syncthing/main.go](https://github.com/syncthing/syncthing/blob/main/cmd/syncthing/main.go)).
Metadata reads are capped at 10 MiB.

**Verification.** The public verification key ships **inside the binary**:
`//go:embed signingkey.pem` → `var SigningKey []byte`, "It must match the private key used to
sign binaries for the built in upgrade mechanism to accept an upgrade"
([lib/upgrade/signingkey.go](https://github.com/syncthing/syncthing/blob/main/lib/upgrade/signingkey.go)).
`verifyUpgrade` validates `release.sig` with `signature.Verify(SigningKey, sig, mr)` where `mr`
is a multireader over _the archive name + newline + the extracted binary contents_ — so the
signature binds the binary bytes **and** the platform/version filename, preventing an attacker
(or a confused mirror) from serving a validly-signed artifact for the wrong platform or version
([lib/upgrade/upgrade_supported.go](https://github.com/syncthing/syncthing/blob/main/lib/upgrade/upgrade_supported.go)).

**Backup/migration ordering.** No data backup in the upgrade path; the previous executable is
kept alongside as `<binary>.old`. Config/DB migration is the new binary's problem at startup.

**Executor.** The process replaces **itself**: download archive → extract → `writeBinary` to a
temp file with mode `0o755` → rename current binary to `.old` → rename temp over the original —
then `os.Exit(svcutil.ExitUpgrade)`. A **monitor process** (the same executable, outer/inner
split via the `STMONITORED` env var: `monitorMain()` vs `syncthingMain()`) interprets exit
codes: `ExitUpgrade` → the monitor re-execs itself "to release the .old binary as part of the
upgrade process", `ExitRestart` (SIGHUP) → restart inner process, `ExitSuccess` → stop
([cmd/syncthing/main.go](https://github.com/syncthing/syncthing/blob/main/cmd/syncthing/main.go),
[cmd/syncthing/monitor.go](https://github.com/syncthing/syncthing/blob/main/cmd/syncthing/monitor.go)).

**Rollback.** None automatic. The monitor only does crash-loop detection: it tracks the last 4
restart timestamps and if all fall within `restartLoopThreshold = 60 * time.Second` it logs
"Too many restarts; not retrying further" and exits with an error (restart pause 1 s)
([cmd/syncthing/monitor.go](https://github.com/syncthing/syncthing/blob/main/cmd/syncthing/monitor.go)).
The `.old` binary exists for manual recovery only; no code path re-launches it.

**Lesson for Veduta:** the monitor/inner exit-code protocol is the reference design for the
ExecStart supervisor wrapper, and name+content signature binding with an embedded pubkey is the
minimal sound verification scheme — but Syncthing's "detect the crash loop, then give up" is
exactly the gap Veduta's automatic symlink-flip + backup-restore rollback closes.

## Tailscale

**Discovery.** Rollout is **server-gated**: "Auto-updates do not happen immediately when a new
version of Tailscale is released. We monitor stability and issue reports for several days
before enabling a release for auto-updates." Auto-update is a tailnet-level policy, on by
default for tailnets created after February 2024, older ones opt in per device; `tailscale
update` (v1.36+) is the manual CLI path
([KB 1067 — Update Tailscale](https://tailscale.com/kb/1067/update)).

**Verification.** The `clientupdate/distsign` package implements a **two-tier Ed25519 key
hierarchy**: "root keys -(sign)-> signing keys -(sign)-> files". Offline root keys sign the
signing-key bundle (`distsign.pub` + `distsign.pub.sig`); per-file signatures (`$file.sig`) are
made with signing keys. "The root public keys are baked into the client software at compile
time... To rotate root keys, a new client release must be published"; signing keys are fetched
fresh "before every download and can be rotated more readily". `Client.Download` fetches file +
signature and validates against the embedded roots
([distsign package docs](https://pkg.go.dev/tailscale.com/clientupdate/distsign)).

**Backup/migration ordering.** Not applicable — the client is near-stateless; no
backup-before-update concept.

**Executor.** Platform-delegated: on Linux "the upgrade command from the package manager used
to install Tailscale"; App Store builds update via the store; Docker via redeploying the
`stable` tag; the control plane triggers, the device-local mechanism applies
([KB 1067](https://tailscale.com/kb/1067/update)).

**Rollback.** None documented in the update KB; risk is managed upstream by the delayed,
gated, observed rollout rather than by device-side reversal.

**Lesson for Veduta:** the two-tier key hierarchy (offline root keys signing rotatable signing
keys, roots embedded in the binary) is the mature answer to key rotation and compromise for
signed release artifacts, and server-side staged gating ("don't offer a release until it has
soaked") is a cheap discovery-endpoint feature that reduces how often rollback is ever needed.

## Gitea

**Discovery.** Operator-driven; the upgrade docs assume you fetch the new binary/package
yourself ([Upgrade from Gitea](https://docs.gitea.com/installation/upgrade-from-gitea)).

**Verification.** Not covered by the upgrade documentation (**unverified** in this research).

**Backup/migration ordering.** Backup is mandatory _because_ migrations are one-way: "Since
you can not run an old Gitea with an upgraded database, a backup should always be made before a
database upgrade" (database, config, `APP_DATA_PATH`, external storage). Migrations are
**migrate-on-boot, blocking**: "On each startup, Gitea verifies that the database is up to date
and will automatically perform any necessary migrations... this can take some additional time
on the first launch during which the application will be unavailable"
([Upgrade from Gitea](https://docs.gitea.com/installation/upgrade-from-gitea)).

**Executor.** The operator replaces the binary and restarts the service; the app itself only
handles the schema.

**Rollback.** Patch releases (1.4.0 ↔ 1.4.1) are interchangeable; across minor/major versions
the database "can not be used for an old Gitea, use a backup to downgrade" — restore is the
only path ([Upgrade from Gitea](https://docs.gitea.com/installation/upgrade-from-gitea)).

**Lesson for Veduta:** the honest baseline for forward-only migrations — once you commit to
them, the pre-update backup _is_ the rollback mechanism for state, so taking it must be
automatic and non-optional rather than a documented manual step.

## t3.chat

No public primary engineering material exists about t3.chat's update/deploy process. It is a
hosted SaaS: the only first-party-adjacent engineering document found is Convex's own
[postmortem of the June 1, 2025 T3 Chat outage](https://news.convex.dev/how-convex-took-down-t3-chat-june-1-2025-postmortem/),
which describes T3 Chat as a client of Convex's managed backend — i.e., standard continuous
deployment onto managed infrastructure, with no self-hosted artifact distribution, signing,
or client-side rollback story. Nothing on [t3.gg](https://t3.gg/) or in Theo's published
material addresses a self-update mechanism. Not relevant to self-hosted update design.

## Patterns and implications for Veduta

1. **The executor lives outside the updated process** in every robust design: HA's Supervisor
   container, Syncthing's monitor process, Tailscale's package manager. Veduta's ExecStart
   supervisor wrapper (apply-on-restart via marker file) is the same shape as Syncthing's
   monitor, with systemd as the outermost layer HA gets from Docker.
2. **Only Home Assistant automates rollback**, and it works because the health check is deep:
   API liveness + required-subsystem checks + an end-to-end frontend probe, plus preserving the
   failed run's log before reverting. Veduta's deep health check should mirror all three layers
   (HTTP up, WS/chat round-trip, Surface render) and keep the failed release's log.
3. **Binary rollback never rolls back data.** HA reverts the image but not the recorder schema;
   Gitea says outright that the old binary cannot run on the new schema. Veduta's automatic
   backup-restore as part of rollback is the missing piece all four systems leave manual —
   with one ordering caveat: running forward-only sqlite migrations _pre-switch_ means a crash
   between migration and symlink flip leaves the old binary facing the new schema. Either the
   marker-file apply must treat migrate+flip as one recoverable transaction (restore backup if
   the flip never lands) or additive-only schema changes must be guaranteed for that window —
   the same tolerant-reader discipline already planned for JSONL.
4. **Signing floor and ceiling.** Floor (Syncthing): one embedded public key, signature over
   _artifact name + contents_ so a valid signature cannot be replayed for the wrong
   platform/version. Ceiling (Tailscale distsign): offline root keys → rotatable online signing
   keys → per-file signatures, roots embedded at compile time. Veduta should at minimum bind
   filename+version into the signed payload; the two-tier hierarchy is the upgrade path if the
   signing key ever needs rotation without re-installing.
5. **Discovery is a boring static JSON over HTTPS everywhere** (`version.home-assistant.io/
{channel}.json`, `upgrades.syncthing.net/meta.json`) with channel as a first-class field
   validated by the client, throttled polling, and a size cap on the metadata read. HA's Update
   entity (`installed_version` / `latest_version` / `INSTALL` / `BACKUP` / `PROGRESS` /
   `RELEASE_NOTES`) is the reference UX contract for in-app one-tap apply with a
   backup-before-update toggle.
6. **A/B is the strongest reversal primitive**: HAOS/RAUC dual boot slots with automatic
   fallback on failed boot. Veduta's `releases/` dir + `current` symlink is the userland
   equivalent — the symlink flip is the "boot slot" switch, and it must stay the single atomic
   commit point of the whole update.

## Sources

- https://developers.home-assistant.io/docs/supervisor/ — Supervisor role, auto-rollback claim
- https://github.com/home-assistant/supervisor/blob/main/supervisor/updater.py — version discovery
- https://github.com/home-assistant/supervisor/blob/main/supervisor/const.py — `URL_HASSIO_VERSION`, channels
- https://github.com/home-assistant/version — published `stable.json`/`beta.json`/`dev.json`
- https://github.com/home-assistant/supervisor/blob/main/supervisor/homeassistant/core.py — update, partial backup, health checks, rollback
- https://developers.home-assistant.io/docs/core/entity/update — Update entity contract
- https://www.home-assistant.io/common-tasks/os/ — update UI, boot slots, downgrade guidance
- https://www.home-assistant.io/common-tasks/general/ — backup-before-update default behavior
- https://github.com/home-assistant/operating-system — RAUC OTA updates
- https://github.com/home-assistant/core/blob/dev/homeassistant/components/recorder/migration.py — live vs blocking schema migrations
- https://docs.syncthing.net/users/releases.html — channels, releases URL override
- https://github.com/syncthing/syncthing/blob/main/lib/upgrade/upgrade_supported.go — fetch, select, verify, replace
- https://github.com/syncthing/syncthing/blob/main/lib/upgrade/signingkey.go — embedded public key
- https://github.com/syncthing/syncthing/blob/main/lib/config/optionsconfiguration.go — default `ReleasesURL`
- https://github.com/syncthing/syncthing/blob/main/cmd/syncthing/main.go — monitor/inner split, exit codes
- https://github.com/syncthing/syncthing/blob/main/cmd/syncthing/monitor.go — restart-loop detection, no auto-rollback
- https://tailscale.com/kb/1067/update — auto-update policy, gated rollout, per-platform executors
- https://pkg.go.dev/tailscale.com/clientupdate/distsign — two-tier signing hierarchy
- https://docs.gitea.com/installation/upgrade-from-gitea — backup mandate, migrate-on-boot, one-way migrations
- https://news.convex.dev/how-convex-took-down-t3-chat-june-1-2025-postmortem/ — t3.chat as hosted SaaS on Convex
