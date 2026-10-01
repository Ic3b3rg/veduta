# Reviewed setup commands

Check: `himalaya --version`. The reviewed compatible version is `2.1.0`.

If absent and the user explicitly requested installation, call `install_himalaya`. The Gateway downloads the pinned v2.1.0 archive from the official release, checks the platform-specific SHA-256 before extraction, verifies the binary's exact version, and stores it under the Gateway data directory. A compatible version already on PATH is reused. Report a failed or unsupported-platform result truthfully. Use `execute_command` for direct CLI inspection with an explicit working directory; a managed installation's absolute path can be found in Gateway data under `bin/himalaya`.

The connection screen writes non-secret account configuration and keeps credentials outside command text. `himalaya -c <config> -a <account-id> --json account check` verifies IMAP and SMTP handshakes and authentication without listing mail. Both `backends` entries must report `ok: true`; command exit status alone is insufficient. For search, `envelope search --json` has a bounded page size and a provider query. `message read` without `--seen` preserves unread state in v2.1.0.
