# Deploying the Veduta daemon (VPS profile)

This directory has the artifacts to run the Veduta daemon (the Gateway) as a hardened
`systemd` service on a VPS with a public IP -- the v1 deployment target described in
[docs/adr/0008-vps-passkey-byok.md](../docs/adr/0008-vps-passkey-byok.md). If you want to
rehearse this flow locally first (passkey login, BYOK or mock routing, persistent config,
restarts) without touching a real VPS, use the **Local VPS profile** described in
[docs/adr/0009-local-vps-profile.md](../docs/adr/0009-local-vps-profile.md) instead -- this
guide is specifically about the real VPS profile.

Hardening rationale (why each directive exists) is in
[docs/SECURITY.md](../docs/SECURITY.md), particularly §6 "Daemon attack surface".

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
`ingestion.sqlite`, `spaces/`, session files, `secrets.vault`, `routing.json`,
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
