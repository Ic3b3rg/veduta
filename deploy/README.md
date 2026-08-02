# Deploying the Veduta daemon (VPS profile)

This directory has the artifacts to run the Veduta daemon (the Gateway) as a hardened
`systemd` service on a VPS with a public IP -- the v1 deployment target described in
[docs/adr/0008-vps-passkey-byok.md](../docs/adr/0008-vps-passkey-byok.md). If you want to
rehearse this flow locally first (passkey login, BYOK or mock routing, persistent config,
restarts) without touching a real VPS, run `pnpm local-vps` -- the **Local VPS profile**
described in [docs/adr/0009-local-vps-profile.md](../docs/adr/0009-local-vps-profile.md) and,
operationally, in [deploy/local-vps.md](local-vps.md) -- instead of this guide, which is
specifically about the real VPS profile.

Hardening rationale (why each directive exists) is in
[docs/SECURITY.md](../docs/SECURITY.md), particularly §6 "Daemon attack surface".

## Zero -- one-command install

On a clean Ubuntu 22.04/24.04 VPS with a domain's A/AAAA record already pointing at it, this
one command automates everything in sections 1-3 below (user/group/directory layout, the
secrets vault keyfile, and the systemd unit), plus installing the pinned Node.js version,
building the daemon, starting it, and printing the pairing QR code:

```sh
curl -fsSL https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh | sudo bash
```

Run it while logged in over SSH (interactively) and it will prompt for your domain and ACME
contact email, then walk through preflight, Node/build, the systemd unit, first boot, and the
pairing QR. For a fully unattended run (e.g. from provisioning automation), pass the values
explicitly:

```sh
curl -fsSL https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh | \
  sudo bash -s -- --apply --domain example.com --email admin@example.com
```

### Flags

| Flag               | Default                                    | Meaning                                                                                                         |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `--domain <d>`     | (prompted)                                 | Public domain (A/AAAA -> this VPS)                                                                              |
| `--email <e>`      | (prompted)                                 | ACME contact email                                                                                              |
| `--repo <url>`     | `https://github.com/Ic3b3rg/veduta.git`    | Repository to clone                                                                                             |
| `--ref <tag\|sha>` | `main` (resolved to a concrete commit SHA) | Git ref to check out                                                                                            |
| `--data-dir <p>`   | `/var/lib/veduta/.veduta`                  | Daemon data directory (`VEDUTA_DATA_DIR`) -- must be strictly under `/var/lib`, `/srv`, `/opt`, or `/var/local` |
| `--apply`          | off                                        | Run unattended (needs `--domain`/`--email` when no tty is attached)                                             |
| `--preview`        | off                                        | Force preview mode, even with a tty attached                                                                    |
| `--help`           | --                                         | Print usage                                                                                                     |

### Reruns are pinned

On a rerun, if `/opt/veduta` already has a checkout and no explicit `--ref` is given, the
installer reuses whatever commit is already checked out instead of re-resolving the moving
`main` branch -- a recovery rerun (retrying after a failed `build` or `systemd-unit` stage,
say) must not silently advance the running code out from under you. Pass `--ref main`
explicitly on a rerun to upgrade to the latest commit.

### The stage protocol

The installer writes a machine-readable event to **stdout** after every stage transition, one
JSON object per line, and nothing else -- every human-readable message (prompts, progress,
warnings, the final pairing URL and QR code) goes to **stderr** instead. A GUI (the PWA's
onboarding wizard) can render a progress bar from stdout alone, without reimplementing any of
the installer's logic:

```json
{
  "protocol_version": 1,
  "stages": [
    { "id": "preflight", "title": "...", "status": "pending|running|done|failed|skipped" }
  ],
  "needs_user_input": false
}
```

The schema is `InstallerStageEventSchema` in `@veduta/protocol`. Stage ids, in order:
`preflight`, `legacy-detect`, `deps`, `user-layout`, `checkout`, `build`, `vault-keyfile`,
`systemd-unit`, `first-boot`, `pairing`. The final stage snapshot is also written to
`<data-dir>/installer-stages.json` (owner `veduta:veduta`, mode `0600`) so the onboarding
wizard can render an installer summary even if it starts well after the install finished.

### Preview discipline

Run without a controlling tty and without `--apply` (for example, piped into a subshell with
its stdin already consumed, or invoked from a script that redirects everything) and the
installer is **preview-only**: it prints the full stage plan (every stage `pending`,
`needs_user_input: true`) on stdout, a human summary of exactly what an apply run would do on
stderr, and exits `0` having written or downloaded nothing. `--preview` forces this mode
explicitly, even with a tty attached. This is structural, not just a convention: every
mutating command in every stage goes through a `run()` wrapper that, in preview mode, only
echoes the command to stderr instead of executing it.

### What the installer never does

- **Never rotates an existing `/etc/veduta/vault.key`.** A keyfile is generated only when
  absent; rotating one in place would make the vault it decrypts undecryptable. Back the
  keyfile up out-of-band (a password manager, not the encrypted application backups, which
  deliberately exclude it -- see §2 below).
- **Never clobbers an existing `<data-dir>/onboarding.json`.** The legacy-detect seed (see
  below) is written only when the file does not already exist, so a rerun never resets a wizard
  that is already in progress or complete.
- **Never fabricates recovery steps.** Every failure prints the exact next command
  (`journalctl -u veduta -n 50`, the rerun invocation) instead of a vague "something went
  wrong"; every stage is idempotent, so reruns are always safe.

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
- Full release-signature verification (a GPG keyring covering signed Veduta releases) is **out
  of scope** for this installer -- it is the [docs/SECURITY.md](../docs/SECURITY.md) §6 "signed
  updates" follow-up, tracked separately.

### Timed acceptance checklist (AC1: clean VPS -> Home in < 15 minutes)

Run this on an actual clean Ubuntu VPS with a domain already pointed at it (this is a manual,
timed exercise -- it cannot be executed from an agent session without a real VPS):

1. Start a timer.
2. `curl -fsSL https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh | sudo bash`
3. Answer the domain/email prompts (or skip them by having passed `--apply --domain --email`).
4. Watch preflight -> legacy-detect -> deps -> user-layout -> checkout -> build ->
   vault-keyfile -> systemd-unit -> first-boot complete.
5. Scan the printed QR code (or open the printed `https://<domain>/setup?code=...` URL) with a
   passkey-capable device/browser.
6. Register a passkey.
7. Walk the onboarding wizard's steps: migration (if a legacy install was detected) -> domain
   confirmation -> BYOK (or skip, for the mock provider) -> model tiers -> first Space ->
   integrations (or skip) -> finish.
8. Land on Home.
9. Stop the timer -- target: **under 15 minutes** end to end.

The sections below (1-5) are the manual reference for exactly what the installer automates --
use them if you are deploying by hand, auditing what the installer does, or debugging a step
it got stuck on.

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
