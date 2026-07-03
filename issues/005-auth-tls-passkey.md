# 005 — Auth: automatic TLS + passkey + device pairing

## Context
[ADR-0008](../docs/adr/0008-vps-passkey-byok.md): public endpoint + serious authentication, no VPN required. [SECURITY.md §6](../docs/SECURITY.md).

## Goal
The daemon is exposed on the internet but nobody gets in without a passkey.

## Tasks
- TLS with built-in ACME (given a domain, the certificate manages itself); 80→443 redirect, HSTS
- WebAuthn/passkey as the only method (no passwords): registration at first boot via a one-time code/QR printed by the installer
- Pairing of additional devices via QR from the "connected devices" Surface; per-device scoped session tokens, revocable
- Authenticated WS (per-connection token, origin check)
- Rate limiting on the auth endpoint; progressive lockout

## Acceptance criteria
- End-to-end setup on a clean VPS: domain → green HTTPS → first passkey registered via QR → login with Face ID/biometrics from the phone
- A revoked token closes the active WS within a few seconds
- No endpoint reachable without auth except: PWA static assets, webhooks (issue 012, with HMAC), ACME well-known

## Dependencies
004
