# 015 — Security hardening: egress allowlist, secrets vault, injection CI

## Context
[SECURITY.md](../docs/SECURITY.md) §3.4, §4, §7 — the explicitly requested reinforced measures.

## Goal
Network and platform defenses that hold even if the prompt gives way.

## Tasks
- **Network-level egress allowlist**: the daemon can only contact declared hosts (configured providers, active integrations, push service, ACME); implementation via a centralized HTTP dispatcher (custom undici Agent) that denies everything else; every denial logged
- **Secrets vault**: encrypted file (key derived at boot from keyfile/env), `secret://` API resolved only by the trust layer at call time; automatic redaction of secret patterns in logs and in the Event log
- **Injection suite in CI**: the issue 013 corpus extended (exfiltration via URLs in fields, unicode smuggling, multi-step instructions) with an assert of "zero ungated L1+ actions"; every discovered bypass becomes a test
- Atomic, restorable encrypted backups (SQLite safe-copy + tar of the memory files), pruning, tested restore command
- Process hardening: systemd unit with `NoNewPrivileges`, read-only filesystem where possible, dedicated user

## Acceptance criteria
- A tool attempting a `fetch` to an undeclared domain is blocked and logged
- `grep` for an API key in plaintext logs/backups: zero occurrences (automated test)
- Restore from backup on a clean machine: working daemon with memory and Surfaces intact
- Injection suite green in CI

## Dependencies
010, 013, 014
