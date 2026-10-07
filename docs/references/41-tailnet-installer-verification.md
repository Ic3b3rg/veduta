# Tailnet installer verification

This report covers [issue #49](https://github.com/Ic3b3rg/veduta/issues/49), building on the
[production installer evidence](40-private-vps-installer-verification.md) for issue #48.
Checks were performed on October 7, 2026, on `feat/private-vps-install`.

## Implemented boundary

The production Gateway accepts one HTTPS `*.ts.net` origin while listening on IPv4 loopback.
Passkeys and Veduta sessions remain mandatory; Tailscale identity headers do not authenticate
a request. The installer asks before installing Tailscale, waits for interactive enrollment,
discloses certificate hostname publication, and verifies a trusted HTTPS request through Serve.
Device approval is an account-wide operator confirmation: the local CLI cannot verify that
setting. The same-tailnet confirmation is retained in root-owned access configuration.

Serve configuration is read before mutation. Occupied endpoints are preserved and a free HTTPS
port is offered. Public Funnel proxies or TCP forwards targeting the chosen loopback backend
are rejected even when they belong to a different endpoint. Missing login, unapproved node
state, removed routes, invalid certificates, and changed hostnames fail without public fallback.

During an access change, the candidate Serve process belongs to the temporary Gateway unit.
Passkey verification precedes promotion to persistent Serve, which precedes the atomic active
origin swap. This ordering keeps a boot-usable origin on either side of that swap. An abrupt
power loss in the commit window can leave an extra private route; generation files retain its
ownership details. Normal abort removes the candidate and restores the old owned root handler
without removing sibling handlers. A changed node hostname is diagnosed before a CLI removal:
the CLI targets the current hostname, so deleting a stale host's route through it is unsafe.
Restore the previous machine name in Tailscale's Machines page before Repair, or remove the
stale route as administrator before Update access. Unrelated routes are never reset.

## Automated and isolated runtime evidence

- The deterministic external CLI fixture covers enrollment states, approval confirmation,
  endpoint conflicts, route ownership, HTTP/TCP Funnel overlap, certificate failure, candidate
  teardown, persistent promotion, hostname drift, and sibling-preserving rollback.
- The real production entry-point test starts with clean persistent data in both Tunnel and
  Tailnet modes. It checks production authentication, expected WebAuthn origin/RP ID, rejection
  of identity-header-only access, and retained bootstrap state after restart. Tailnet transport
  is simulated locally in this test; it does not claim a real Serve certificate.
- An isolated Ubuntu 24.04 systemd container verified that a running child unit with `PartOf`
  becomes inactive when its parent is stopped. This checks the service-manager lifecycle, not
  Tailscale enrollment or a complete Tailnet browser journey.
- Independent Standards and Spec reviews reproduced cross-endpoint Funnel exposure, unsafe
  hostname removal, sibling rollback failure, commit ordering, and misleading preview output.
  Regression tests cover the fixes.

The final `pnpm check` passed lint, formatting, typechecks, all **3,960 package tests**, and
builds. Both review axes found no remaining blocker in the fixes; real-device acceptance is
still pending. Public backend checks use standard URL normalization, including equivalent
loopback spellings and effective default ports. Run `pnpm check` to repeat these checks.
The opt-in browser
test in `packages/e2e/tests/installer-smoke.spec.ts` supports
`VEDUTA_INSTALLER_SMOKE_MODE=tailnet` and uses normal certificate verification. It must target
a clean test installation waiting for its initial passkey, never a personal installation.

## Real VPS status and remaining verification

The owner's Ubuntu 26.04 VPS is reachable through their existing Mac SSH agent. The original
SSH failure was a missing agent socket in the process environment, not a missing server key.
The Tunnel production journey and real reboot passed as recorded in the preceding report.
Tailscale 1.102.5 was installed from the official distribution, and interactive login produced
an authentication link. It timed out without enrollment; the last observed state was
`NeedsLogin`. No private key, auth key, or account password was requested or copied.

**Real Tailnet acceptance is pending.** A CLI fixture, loopback origin test, or Public ACME lab
does not establish real Tailnet HTTPS, phone access, QR usability, or reboot persistence.
Issue #49 must remain open until that evidence is recorded. Do not label this branch as a
published release or apply the old `0.0.6` artifact to a private source installation.

## Real-tailnet smoke to complete

1. In the guided installer, select **Private on all your devices — Tailscale**. On a clean VPS,
   verify explicit installation consent. Follow the login link, enable Device approval, approve
   the VPS, and acknowledge the certificate-name disclosure. Complete HTTPS consent if shown.
2. With Tailscale connected on an approved computer, open the printed setup link, register a
   passkey, and continue in the PWA. Confirm **Private · Tailscale** and the exact address.
   Reload, sign out, and sign in again.
3. Scan the QR from an approved phone on mobile data. Use the same HTTPS address and a synced
   passkey or browser-supported cross-device authentication. Repeat after closing the browser.
   From a fresh browser on a device outside the tailnet, confirm the endpoint is unreachable.
4. Inspect the Gateway listener and Serve status: loopback only, no Funnel on any path to the
   backend. Reboot the VPS; repeat computer/phone sign-in and verify the address is unchanged.
5. On disposable test data, repeat Tunnel-to-Tailnet and Public-to-Tailnet changes. Preserve
   hashes of the old auth store, vault key, update pinning, onboarding, and configured Model
   connections. Inject certificate/reachability/pairing failure and verify both old browser
   access and unrelated Serve/Funnel configuration. Repeat with successful passkey registration.
6. Disconnect Tailscale, remove only the test-owned route, and test hostname drift separately.
   Verify no public fallback and follow the precise SSH recovery message. Restore each test
   condition before proceeding, then remove disposable credentials and test artifacts.

## Primary sources

- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) and its
  [CLI contract](https://tailscale.com/docs/reference/tailscale-cli/serve).
- [Device approval](https://tailscale.com/docs/features/access-control/device-management/device-approval)
  and [key expiry](https://tailscale.com/docs/features/access-control/key-expiry).
- [Official Serve CLI implementation](https://github.com/tailscale/tailscale/blob/main/cmd/tailscale/cli/serve_v2.go):
  hostname selection and handler-scoped removal. The undocumented `set-raw` command is not used.
