# Deploying Veduta on a VPS

The production VPS profile uses a dedicated hardened systemd service, persistent data,
mandatory passkeys, and signed updates. Browser access is a separate choice: **Tailnet** uses
private Tailscale HTTPS on computer and phone; **Tunnel** uses an SSH forward on a computer;
**Public** uses a domain and ACME HTTPS. See
[ADR-0015](../docs/adr/0015-vps-access-modes.md) and the [installation guide](../README.md#install-on-a-vps).
For development on your own computer, use the separate [Local VPS profile](local-vps.md).

## Guided installation

On Ubuntu with systemd, SSH, sudo, and curl, run this in your SSH session:

```sh
curl -fsSLo veduta-install.sh \
  https://raw.githubusercontent.com/Ic3b3rg/veduta/a53c80ce49eff69d2c058af1ff642528f3e0a812/deploy/install.sh &&
sudo env SSH_CONNECTION="$SSH_CONNECTION" bash veduta-install.sh \
  --ref a53c80ce49eff69d2c058af1ff642528f3e0a812
```

The download and `--ref` pin the reviewed source snapshot used by this guide. These changes
are on `main`, ahead of the published `v0.0.6` release. Keep both references aligned.

Enter accepts the displayed defaults. Tailnet is preselected on a connected Tailscale host;
otherwise Tunnel is preselected. Public access is never selected implicitly. To go directly
to private computer-and-phone access, append `--access tailnet` to the command above.
The installer shows the plan before making changes. After building, it prints a complete
foreground SSH command to run **on your computer**, then a localhost setup link. Keep the
forward running, register a passkey, and continue onboarding in the PWA. Tunnel access does
not support phones. Public access requires DNS pointing to the VPS and TCP ports 80/443;
it prints an HTTPS link and QR instead.

Download the script before invoking sudo. An interactive `curl | sudo bash` can suspend its
prompt reader under sudo-rs; the installer detects this form and prints a file-based retry.
Normal output is concise progress on stderr. Package/build output is kept in a root-only
`/var/log/veduta-install.*.log`; failures include the recent log and exact recovery command.

Explicit unattended configuration skips terminal questions but still waits for passkey
registration in the browser:

```sh
sudo bash veduta-install.sh --apply --access tunnel --ssh-target ubuntu@your-vps
sudo bash veduta-install.sh --apply --access public --domain veduta.example.com --email owner@example.com
```

### Flags

| Flag                               | Default                                                | Meaning                                                            |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `--access tunnel\|tailnet\|public` | Tailnet when connected; otherwise Tunnel               | Browser transport, independent of the production profile           |
| `--port <n>`                       | 8788, or installed value                               | Stable loopback and client-forward port                            |
| `--tailnet-port <n>`               | 443, or installed value                                | Private HTTPS port; occupied endpoints are never overwritten       |
| `--install-tailscale`              | Prompt when missing                                    | Consent to install the official Tailscale package                  |
| `--device-approval-confirmed`      | Prompt, or saved for the same tailnet                  | Operator confirms account-wide Device approval is enabled          |
| `--accept-certificate-name`        | Disclosure before guided confirmation                  | Accept certificate hostname publication in unattended setup        |
| `--ssh-target user@host`           | Detected from SSH                                      | Editable destination for the generated client command              |
| `--ssh-port <n>`                   | Detected SSH port, otherwise 22                        | SSH server port                                                    |
| `--domain <d>` / `--email <e>`     | Existing values or prompted                            | Public DNS name and ACME contact                                   |
| `--repo <url>`                     | Upstream repository                                    | Source checkout                                                    |
| `--ref <tag\|sha>`                 | main on first install; existing commit on repair       | Ref resolved to an immutable commit                                |
| `--data-dir <p>`                   | `/var/lib/veduta/.veduta`                              | Data directory beneath `/var/lib`, `/srv`, `/opt`, or `/var/local` |
| `--update-feed <url>`              | Upstream stable feed                                   | Signed update channel                                              |
| `--update-root-key <key\|@file>`   | Bundled upstream public key on fresh upstream installs | Pin a custom signing root; never a private key                     |
| `--apply`                          | Off                                                    | Explicit unattended configuration                                  |
| `--preview`                        | Automatic without a TTY unless `--apply`               | Read-only plan, no downloads or changes                            |
| `--json`                           | Off                                                    | Emit the stage protocol on stdout                                  |
| `--skip-codex`                     | Off                                                    | Skip optional ChatGPT subscription support                         |

### Recovery and access changes

- `sudo veduta setup` regenerates the setup link without rebuilding. Interrupting an initial
  pairing wait leaves the service running; registered passkeys are retained.
- `sudo veduta access` offers Repair, Update access, or Exit. Installed values remain the
  Repair defaults. Update access offers the safe detected mode with editable values. A normal installer rerun also offers these choices; Repair rebuilds its pinned
  checkout, while the administrative command only repairs access.
- A changed browser origin starts a temporary service and requires a new passkey. The old
  boot configuration remains active until verification succeeds. Cancellation, failure, a
  15-minute deadline, or reboot restores the old configuration. Application data and update
  pinning are not replaced. The PWA reconnects during the final service restart.
- For an installation that predates these commands, run `sudo bash veduta-install.sh --ref main` and choose Repair
  with its current access first; then use `sudo veduta access`.

The root-owned administration scripts live in `/usr/local/lib/veduta`. Access configuration
is versioned under `/etc/veduta/access`, with `active` pointing to the committed generation.
The public setup address is in `/etc/veduta/access.json`; its directory remains root-only.
Passkey stores are separate from application data so an aborted new-origin registration does
not revoke the old origin's credentials. A new WebAuthn user handle prevents a same-RP port
change from replacing an existing discoverable credential before commit.

An occupied server port is identified and a free alternative offered as an editable default.
The installer checks SSH reachability and local-forwarding support. Client-side port conflicts
are reported by SSH's `ExitOnForwardFailure`; close an old forward or change the stable port
through `sudo veduta access` rather than silently using a different WebAuthn origin.

### Tailnet access

1. Install Tailscale on your computer and phone, using the same personal account. Enable
   [Device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)
   and approve those devices in the Tailscale admin console. Keep the tailnet limited to intended users.
2. Choose **Private on all your devices — Tailscale** in the installer. If needed, it requests
   consent before downloading Tailscale's official Linux installer. Follow the interactive login
   link and approve the VPS. No auth key or passphrase belongs in an installer argument.
3. Confirm account-wide Device approval. The local CLI reports whether this node is connected,
   but cannot verify that global policy; Veduta records your confirmation for this tailnet.
4. If HTTPS is not enabled, `tailscale serve` prints a browser activation URL such as
   `https://login.tailscale.com/f/serve?node=...`. Open the exact URL printed on this VPS and
   approve Serve/HTTPS with your personal account. The node identifier is supplied by Tailscale;
   never hardcode one in shared instructions. Leave public Funnel access disabled if offered.
   Keep the installer running: it resumes after approval and waits for a valid HTTPS response,
   including initial certificate issuance. If the wait has expired, complete approval and use
   the installer's retry command. An already-enabled tailnet skips this browser prompt.
   The certificate hostname is published in Certificate Transparency logs; the web service
   remains reachable only within your tailnet. See the [step-by-step guide](../README.md#2-run-the-installer-on-the-vps).
5. Open the HTTPS link or QR with Tailscale connected, register the first passkey, and continue in the PWA.
   To add another device afterward, use **Connections → Devices → Link a device** from the
   authenticated PWA. Its short-lived QR lets the new device register its own passkey; the original
   installer code is already consumed. The Devices controls can revoke another registered access.

The Gateway listens only on `127.0.0.1`. [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
provides HTTPS; Veduta never enables Funnel and never treats Tailscale identity headers as a
login. The installer checks connection, MagicDNS, HTTPS capability, private route ownership,
and a trusted HTTPS request to the production Gateway. Port 443 is used only when free; an
occupied Serve/Funnel endpoint produces an editable free-port suggestion such as 8443.
The selected port becomes part of the stable address and must remain the same in your bookmarks.
Unrelated routes are preserved, including when removing Veduta's own root handler.

An access change stages a foreground Serve route under a temporary systemd unit. Cancellation,
timeout, and reboot during pairing remove it. After passkey verification, setup makes Serve
persistent before atomically switching the active origin. A power loss in that short commit
window can leave an extra private route, but the old origin remains usable until the swap and
the new one is boot-ready afterward. Root-owned generation files retain its recovery details.
Initial installations keep their private service available if pairing is interrupted.
After successful setup, Serve and Veduta resume on boot without a terminal or SSH forward.

Logout, device removal, or a missing route cannot expose the loopback Gateway publicly.
Reconnect and approve the VPS, then use `sudo veduta access` → **Repair** over SSH. A changed
hostname requires **Update access** and a new passkey. External Tailscale configuration changes
may require administrator repair; Veduta does not silently switch to Public or Tunnel access.
Keep SSH access available for recovery. Do not publish this endpoint with Funnel or share the
server with other tailnets if it must remain restricted to your approved devices.

Tailscale node credentials can expire. Review the VPS's expiry policy in the Tailscale admin
console and follow [Tailscale's key expiry guidance](https://tailscale.com/docs/features/access-control/key-expiry).
For a trusted VPS that must stay connected unattended, **Machines → VPS menu → Disable key
expiry** avoids periodic server sign-in. That device stays authorized until you revoke or remove
it; keep your account secure and remove retired devices. Veduta does not change this policy
automatically.

Unattended Tailnet setup requires an **already connected** node and explicit confirmations:

```sh
sudo bash veduta-install.sh --apply --access tailnet \
  --device-approval-confirmed --accept-certificate-name
```

If the default HTTPS port is occupied, supply the free `--tailnet-port` shown in the error.
Enrollment remains interactive; this mode does not provision auth keys.

### The stage protocol

Preview and `--json` emit newline-delimited `InstallerStageEventSchema` values on stdout.
The existing `protocol_version`, `stages`, and `needs_user_input` fields are retained. Additive
fields identify `access_mode`, `state` (`preview`, `planning`, `running`, `waiting-input`,
`waiting-passkey`, `complete`, or `failed`), and `repair_command`. Bootstrap codes never appear
in this protocol or its persisted `<data-dir>/installer-stages.json` snapshot. The one-time
setup URL is printed only in the terminal handoff.

Stages remain preflight, legacy-detect, deps, user-layout, checkout, build, vault-keyfile,
systemd-unit, first-boot, and pairing. Administrative access changes mark unrelated stages
skipped. `--preview` never calls a stage implementation.

### Legacy agent migration

Before any escalation side effect, the installer captures the invoking admin's home directory
(the `SUDO_USER`'s home, or `/root`) and checks it for `.openclaw` and `.hermes`. If either is
found, the result (never the file contents) is seeded into
`<data-dir>/onboarding.json` as `legacy: { openclaw, hermes, sourceHome }` -- the daemon itself
runs as the unprivileged `veduta` user under `ProtectHome=yes` and can never see `/home/*`
directly. The onboarding wizard's `migration` step then offers to import before any manual
configuration happens (issue 019 AC3); the importer itself ships with issue 020.

### Migrating from OpenClaw or Hermes

Detection alone (above) isn't enough to make the wizard's `migration` step useful on a real
VPS: it only records a boolean, and the daemon running as `veduta` under `ProtectHome=yes` can
never itself read `/home/<admin>/.hermes` or `/home/<admin>/.openclaw` to import from them. So
the `user-layout` stage, once it has created `<data-dir>` as `veduta:veduta`, also stages the
detected install's memory-and-identity files -- and only those -- into
`<data-dir>/import-source/<openclaw|hermes>/`: `SOUL.md`, `USER.md`, `MEMORY.md`, and a
`notes/` directory of `.md` daily/topic notes, owned `veduta:veduta`, mode `0600` (`0700` for
the directories). **Secrets are never staged** -- `.env`, `auth.json`, `openclaw.json`,
`state.db`, `sessions/`, `logs/`, `skills/`, `cron/`, `pending/`, and anything else in the
legacy install stay exactly where they are, untouched, unread, uncopied. That is what makes
the wizard's import path secret-free by construction: the wizard previews and imports only
this staged, non-secret memory.

Importing a secret (a provider API key found in a legacy `.env` or `openclaw.json`), or
migrating from a source the daemon cannot read at all, is instead a CLI-only operation:

```sh
sudo pnpm --filter @veduta/daemon run import-legacy <openclaw|hermes> \
  --root /var/lib/veduta/.veduta --home /home/<admin> --apply --secrets
```

Drop `--apply` for a dry run (the default: it prints the grouped preview and writes nothing)
and `--secrets` to leave the provider keys behind. The script is `import-legacy`, not
`import`, because pnpm has a built-in `import` command that would shadow it. Stop the daemon
before importing secrets — the CLI refuses otherwise, since it must not race the running
daemon's in-memory vault.

### Supply-chain trust root

- The repository is cloned over GitHub's TLS and pinned to a concrete commit SHA, resolved
  with `git rev-parse` and hard-reset to -- even when `--ref` names a branch or tag, the
  resolved SHA (printed to stderr, and part of the final human summary) is what actually gets
  built and run.
- The Node.js tarball is downloaded over TLS from `nodejs.org` and verified against that
  release's published `SHASUMS256.txt` with `sha256sum -c` before extraction.
- The initial source checkout relies on GitHub TLS and the selected commit. Subsequent signed
  updates use the Minisign trust chain described in [RELEASING.md](../RELEASING.md). Fresh
  upstream installs pin the bundled public root; custom repositories must supply their own.

### Runtime verification

The [installer verification report](../docs/references/40-private-vps-installer-verification.md)
records the tested operating systems, terminal failure, real VPS journey, Public HTTPS lab,
access rollback, and remaining limitations. The [Tailnet verification report](../docs/references/41-tailnet-installer-verification.md)
separates automated evidence from the pending real-device smoke and gives its exact steps.
To repeat the Tunnel journey, start a timer, run the
guided installer on a clean VPS, accept Tunnel defaults, run the generated SSH command on your
computer, and register a passkey. The target is under 15 minutes to registration. Reload,
sign out, and sign in again, then repeat after a service restart and reboot.

For Public regression, choose Public with working DNS, open the HTTPS link or QR, register a
passkey, and follow the PWA onboarding steps. A clean controlled installation can also run the
opt-in browser test with `VEDUTA_INSTALLER_SMOKE_URL` (and `VEDUTA_INSTALLER_SMOKE_MODE=public`).
Never point this test at an installation with personal data or passkeys.

The sections below are the manual reference for the user, vault, service, backups, and updates.

## 1. Dedicated user, group, and directory layout

Create a system account with no login shell and no password -- the daemon never needs an
interactive session:

```sh
sudo groupadd --system veduta
sudo useradd --system --gid veduta --home /var/lib/veduta --shell /usr/sbin/nologin veduta
```

Layout:

| Path                      | Owner           | Mode | Purpose                                                          |
| ------------------------- | --------------- | ---- | ---------------------------------------------------------------- |
| `/opt/veduta`             | `root:root`     | 0755 | Checked-out / built code (read-only to the `veduta` user)        |
| `/var/lib/veduta`         | `veduta:veduta` | 0700 | The `veduta` user's home (`WorkingDirectory` in the unit)        |
| `/var/lib/veduta/.veduta` | `veduta:veduta` | 0700 | Data root -- `VEDUTA_DATA_DIR` (Spaces, stores, sessions, vault) |
| `/etc/veduta/vault.key`   | `veduta:veduta` | 0400 | Secrets vault keyfile                                            |

```sh
sudo mkdir -p /var/lib/veduta
sudo chown veduta:veduta /var/lib/veduta
sudo chmod 0700 /var/lib/veduta
sudo mkdir -p /etc/veduta
sudo chown root:root /etc/veduta
sudo chmod 0755 /etc/veduta
```

`index.ts` reads `VEDUTA_DATA_DIR` directly, so the data root is exactly what the unit sets:
**`/var/lib/veduta/.veduta`** (where `trust.sqlite`, `surfaces.sqlite`, `scheduler.sqlite`,
`automation-outcomes.sqlite`, `ingestion.sqlite`, `spaces/`, session files, `secrets.vault`, `routing.json`,
`ingestion.json`, `usage/`, and `egress-denials.jsonl` all live). The vault and backup CLIs
must be pointed at this same path (`--root /var/lib/veduta/.veduta`) so they operate on the
data the running daemon actually reads -- that is also what you back up and restore.

## 2. Secrets vault

Provider API keys and OAuth tokens are never stored in plaintext or handed to the agent
(docs/SECURITY.md §4): they live in an AES-256-GCM encrypted vault file
(`<data dir>/secrets.vault`), decrypted at boot using key material read from
`VEDUTA_VAULT_KEYFILE`.

Generate a keyfile once, before the first boot:

```sh
sudo install -d -m 0755 /etc/veduta
head -c 48 /dev/urandom | base64 | sudo tee /etc/veduta/vault.key > /dev/null
sudo chown veduta:veduta /etc/veduta/vault.key
sudo chmod 0400 /etc/veduta/vault.key
```

`veduta:veduta 0400` (rather than `root:veduta 0640`) is deliberate: the daemon is the only
reader, it already runs as the dedicated `veduta` user, and this avoids maintaining a
separate `root:veduta` group ACL for a single-reader file. Nothing but the `veduta` account
(and `root`, which can always override permissions) can read the key.

**Never commit this file or print its contents.** Back it up out-of-band (e.g. your
password manager); it is not included in the encrypted application backups below by
design -- a stolen backup archive must not also carry the key that decrypts it.

Once the daemon has booted at least once with a vault keyfile present, load secrets into it
with the vault CLI:

```sh
# from the repository (or /opt/veduta if that is where the built code lives):
VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key \
  pnpm --filter @veduta/daemon vault set anthropic sk-ant-... --root /var/lib/veduta/.veduta

# list stored names (never values):
VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key \
  pnpm --filter @veduta/daemon vault list --root /var/lib/veduta/.veduta

# remove a secret:
VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key \
  pnpm --filter @veduta/daemon vault delete anthropic --root /var/lib/veduta/.veduta
```

`--root` must point at the daemon's actual data directory (see the quirk above --
`/var/lib/veduta/.veduta`, not `/var/lib/veduta`). Run these as the `veduta` user (or
`sudo -u veduta`) so file ownership on the vault stays correct.

## 3. Install the unit

```sh
sudo cp deploy/veduta.service /etc/systemd/system/veduta.service
# edit VEDUTA_PUBLIC_DOMAIN / VEDUTA_ACME_EMAIL and the ExecStart path for your build, then:
sudo systemctl daemon-reload
sudo systemctl enable --now veduta.service
```

Check it came up and watch for the first-boot passkey pairing code (docs/SECURITY.md §6 --
passkey/WebAuthn only, no passwords):

```sh
sudo systemctl status veduta.service
sudo journalctl -u veduta.service -f
```

## 4. Backups and restore

The daemon ships a backup CLI (`packages/daemon/src/backup-cli.ts`, package script
`backup`) that snapshots every SQLite store consistently (`VACUUM INTO`), tars the rest of
the data directory (Spaces, sessions, `USER.md`/`SOUL.md`, config files, the encrypted
vault itself), and AES-256-GCM-encrypts the archive with its own backup-purpose key derived
from the same key material as the vault (domain-separated, so a leaked vault key alone does
not also decrypt backups without also reading the keyfile). Confirm the exact subcommand
names against that file if it has changed since this guide was written; the shape below is
`backup | restore | prune`.

### Scheduled backups

A `systemd` timer keeps the backup tied to the same service account and environment as the
daemon. Example (`/etc/systemd/system/veduta-backup.service` +
`/etc/systemd/system/veduta-backup.timer`):

```ini
# /etc/systemd/system/veduta-backup.service
[Unit]
Description=Veduta encrypted backup

[Service]
Type=oneshot
User=veduta
Group=veduta
WorkingDirectory=/opt/veduta
Environment=VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key
ExecStart=pnpm --filter @veduta/daemon backup backup --root /var/lib/veduta/.veduta --out /var/lib/veduta/backups
ExecStartPost=pnpm --filter @veduta/daemon backup prune --out /var/lib/veduta/backups --keep 7
```

```ini
# /etc/systemd/system/veduta-backup.timer
[Unit]
Description=Daily Veduta backup

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl enable --now veduta-backup.timer
```

A plain cron entry works just as well if you prefer it:

```
0 3 * * * veduta VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key pnpm --filter @veduta/daemon backup backup --root /var/lib/veduta/.veduta --out /var/lib/veduta/backups
```

Copy the resulting `veduta-backup-<ISO>.tar.enc` files off the host (object storage, another
machine) -- a backup that only ever lives next to the data it protects is not a backup.

### Restore on a clean machine (issue #15, AC3)

This is the scenario the acceptance criteria call out explicitly: given only an encrypted
backup archive and the vault keyfile, bring up a fully working daemon -- memory (FACTS,
Event log) and Surfaces intact -- on a machine that has never run Veduta before.

1. Provision the host as in sections 1-3 above (user/group, directories, install the
   `systemd` unit) but **stop before first boot** -- do not let the daemon create a fresh,
   empty data directory.
2. Copy the vault keyfile to `/etc/veduta/vault.key` (same content as the original; the
   backup's encryption key is derived from it) and the backup archive
   (`veduta-backup-<ISO>.tar.enc`) onto the new host.
3. Ensure `/var/lib/veduta/.veduta` does not exist or is empty -- restore only targets an
   empty data directory, by design (it refuses to merge into or overwrite an existing one):
   ```sh
   sudo -u veduta mkdir -p /var/lib/veduta/.veduta
   ```
4. Restore:
   ```sh
   sudo -u veduta env VEDUTA_VAULT_KEYFILE=/etc/veduta/vault.key \
     pnpm --filter @veduta/daemon backup restore veduta-backup-<ISO>.tar.enc --target /var/lib/veduta/.veduta
   ```
5. Start the daemon and verify:
   ```sh
   sudo systemctl start veduta.service
   sudo journalctl -u veduta.service -f
   ```
   Log in via the PWA (or re-pair a device if this is a fresh passkey relying-party ID) and
   confirm existing Spaces, their FACTS, and their Surfaces are present exactly as they were
   before -- that end-to-end check, not just the restore command's exit code, is what
   satisfies AC3.

## 5. Verify the hardening

After installing the unit, ask `systemd` itself to score the sandbox:

```sh
sudo systemd-analyze security veduta.service
```

Expect a low overall exposure score (`systemd-analyze security` reports lower as more
hardened, roughly in the 1-4 range once every directive above is in place) with no
`UNSAFE`-flagged line for the directives this unit sets -- `NoNewPrivileges`,
`ProtectSystem`, `ProtectHome`, the `Protect*Kernel*`/`ProtectControlGroups` group,
`PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies`, `RestrictNamespaces`,
`LockPersonality`, `RestrictRealtime`, `SystemCallFilter`, and the capability bounding set.
`MemoryDenyWriteExecute` will still show as a gap in the report -- that is expected and
intentional (see the comment in `veduta.service`): Node's V8 JIT requires W^X-violating
pages, so this one directive is not set, and its absence should not be treated as a
regression to fix.

## Updates

Once installed, a Veduta instance updates itself with no SSH session and no re-run of this
installer -- the full design is [docs/adr/0013-signed-self-update.md](../docs/adr/0013-signed-self-update.md)
(especially its "Amendments" section, authoritative for the on-disk layout below); the
maintainer-facing release ceremony that produces what gets offered is
[RELEASING.md](../RELEASING.md).

### How it works, operationally

A daily, switchable Automation ("Check for updates") polls the signed update feed. A new
release surfaces as a badge on Home and an update Surface (current version, available version,
release notes, and whether this update migrates your data). One tap on Apply:

1. The daemon writes an update marker (the verified offer, frozen at apply time) and exits with
   a dedicated code.
2. The supervisor wrapper's transaction runs: download -> verify the signed chain
   (root -> signing key -> release metadata) -> back up the data root (the existing
   `createBackup`, tagged pre-update) -> forward-only migrations, if the release's `dataVersion`
   moved -> flip the `current` symlink -> start the new release's daemon -> a deep health check
   (every store opens, Spaces list, a full surface-event replay -- not just "the process is
   alive").
3. If every step passes, the wrapper prunes old releases/backups and updates itself last.
4. If any step fails, the wrapper **automatically rolls back**: the symlink flips back, the
   pre-update backup is restored, the failed release's log is preserved on disk, the previous
   version restarts, and the Update Surface reports what happened -- no operator input, no data
   loss, because the daemon is down for the entire window and cannot have accepted new data that
   the restore would then discard.

Retention: `current` plus the two previous releases; the three most recent pre-update backups,
kept in their own directory so this never touches or competes with the operator's own daily
backup schedule (§4 above). Both are pruned only after a successful update, never speculatively.

### Where things live

| Path                                                  | Purpose                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/var/lib/veduta/updates/releases/vX.Y.Z/`            | One unpacked, verified release tree per version                                                            |
| `/var/lib/veduta/updates/releases/current`            | Symlink to the release currently serving -- flipping it is the "install" step                              |
| `/var/lib/veduta/updates/runtimes/node-v<ver>-linux/` | Shared, SHA-verified Node runtimes a release's `RUNTIME` file points at                                    |
| `/var/lib/veduta/updates/bin/veduta-run`              | The supervisor wrapper -- the unit's `ExecStart`, self-updates last                                        |
| `/var/lib/veduta/updates/state/`                      | The transaction journal, terminal results, and `state/logs/<version>.log` for a failed release (see below) |
| `/var/lib/veduta/updates/backups/`                    | Pre-update backups only -- separate from the operator's scheduled backups                                  |
| `/etc/veduta/update.json`                             | Root-owned trust anchors: `{feedUrl, rootPublicKey}`, written only by the installer                        |

`/etc/veduta/update.json` is root-owned deliberately: the daemon runs as the unprivileged
`veduta` account (§1 above) and therefore necessarily owns the code it updates, the same
posture Syncthing and Tailscale ship with -- but it must never be able to repoint its own
update channel or swap the root of trust. A fork gets its own update channel with zero source
patches via the installer's `--update-feed`/`--update-root-key` flags. The feed URL defaults to
this project's own `feed/stable.json`. A fresh install from the upstream repository pins the
bundled [root public key](../docs/keys/root.pub). The [signing public key](../docs/keys/signing.pub)
and its [root signature](../docs/keys/signing.pub.minisig) are published alongside it;
[RELEASING.md](../RELEASING.md) documents verification of the full chain.

Custom repositories or feeds must provide `--update-root-key @/path/to/root.pub`; without it,
updates remain unconfigured and the installer prints a recovery notice. Existing trust anchors
are preserved unless explicitly replaced. Omit `--ref` on ordinary recovery reruns to retain
that checkout; use the Updates Surface for releases that migrate data. The private source
candidate requires a newer signed release than `0.0.6`, which only supports Public access.

A release that fails its health check leaves its supervised daemon's output behind at
`/var/lib/veduta/updates/state/logs/<version>.log` -- preserved across the rollback, specifically
so "what actually went wrong" survives long enough to read, in the same spirit as the
append-only audit log described in [docs/SECURITY.md](../docs/SECURITY.md) §5.
