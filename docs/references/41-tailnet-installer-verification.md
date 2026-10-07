# Tailnet installer verification

This report covers [issue #49](https://github.com/Ic3b3rg/veduta/issues/49), building on the
[production installer evidence](40-private-vps-installer-verification.md) for issue #48.
Checks were performed on October 7–8, 2026, on `feat/private-vps-install`.

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

After the certificate-readiness and multi-device corrections, `pnpm check` passed lint,
formatting, typechecks, all **3,976 package tests**, and builds. Both review axes found no
remaining blocker in the fixes; real-device acceptance is still pending. Public backend checks
use standard URL normalization, including equivalent
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

The production installer then rebuilt the VPS from the reviewed and pushed source commit
`8c8719530fe6b8e4e0e9abeff80eee13923cb43d`, preserving its existing Tunnel access. The checkout
now has the upstream GitHub remote and no uncommitted changes. The service restarted with
production authentication. SHA-256 checks of the active passkey store, vault key, update
pinning, and onboarding state all matched their pre-upgrade values.

A real administrative Tailnet change without enrollment exited with the expected login and
approval recovery instructions before replacing access configuration. The previous Tunnel
service stayed active, all four hashes still matched, and socket inspection still showed the
Gateway only on `127.0.0.1:8789`, with no public application listener. This verifies the
unenrolled error path, not successful Tailnet activation. Disposable Docker lab containers,
their network, generated test results, and the custom lab image were removed afterward.

### Enrollment and first HTTPS activation

The owner subsequently completed enrollment, confirmed Device approval and VPS approval,
and enabled Serve/HTTPS. The first real activation exposed a certificate-readiness race:
the installer used one curl request with a five-second connection deadline while Tailscale
was issuing the first certificate. It aborted the temporary route before issuance completed.
The old Tunnel service and its configuration were restored. Tailscale obtained the certificate
about 45 seconds after its initial request, confirming that immediate reachability was not a
valid first-certificate readiness assumption.

The verifier now retries a bounded set of transient connection/TLS-handshake failures up to
12 times (20 seconds per request, two seconds between attempts), retaining ordinary certificate
validation. Invalid certificates fail immediately. Success still rechecks the production auth
status, hostname, private Serve route and absence of any public proxy to the backend. Regression
tests cover transient recovery and exhaustion. The prompt describes the 15-minute candidate
lifetime as a total deadline, including certificate checks.

With that fix staged on the VPS, activation completed. The owner registered a real passkey on
the computer and finished onboarding. Serve persisted the HTTPS route; no foreground candidate
or Funnel route remained. The Gateway listened only on IPv4 loopback, while HTTPS listened on
the Tailscale addresses. A trusted HTTPS request from the Mac returned production auth status
with a registered passkey. A TLS request forced to the public VPS IP timed out before connecting.
The old auth store, vault key, and update pinning hashes remained unchanged. Onboarding changed
because the owner completed the wizard, so its earlier hash is no longer an appropriate
preservation comparison.

The owner's Android/Brave screenshot confirms that the phone also reaches the private PWA.
Google Password Manager reports **No passkeys available**: network reachability succeeded but
the phone has no usable credential. Investigation found that the authenticated pairing APIs
existed while the PWA had no linking/revocation controls, and AuthGate hid registration after
any first passkey, even for an additional-device pairing URL. Existing browser tests paired
secondary devices through direct API calls, bypassing that missing user journey.

### Multi-device correction

The protected PWA now exposes **Connections → Devices**, with a generic Markdown handoff from
the existing Connected devices System Surface and an entry during onboarding. The authenticated
owner generates a ten-minute QR/link; the receiving device registers its own passkey. The code
is checked again after asynchronous WebAuthn verification so consumption, expiry, and issuer
revocation cannot be bypassed by an already-started ceremony. Concurrent verification admits
only one registration. The current credential is identified in the management flow and cannot
be accidentally revoked there; other credentials require an explicit confirmation. The UI
explains that revocation also covers synced copies of the same passkey.

The browser regression in `packages/e2e/tests/device-pairing.spec.ts` uses a fresh Local VPS
installation and two isolated Chromium contexts with independent virtual authenticators. It
passes through the actual UI to issue a link, register the second passkey, view the same Space,
reload, sign in again, revoke only the second access, observe the live return to sign-in, and
reject reuse of the pairing link while retaining the first access. These virtual credentials
and the disposable data root are removed by the fixture; this is not a physical-phone claim.

That browser test also exposed a late onboarding restart callback that navigated to Home after
the wizard had already unmounted. A failing regression reproduced it; cancelling work when the
wizard leaves prevents navigation from interrupting the new Devices flow. App-level tests cover
pairing during unfinished onboarding, a linking URL in an already authenticated browser, and
choosing an existing passkey without getting stuck on the linking screen. UI tests also cover
manual/focus refresh after enrollment and stale reads arriving after revocation.

**Real Tailnet acceptance remains pending** for successful phone authentication, QR usability,
and reboot persistence. Issue #49 stays open until that evidence is recorded. This branch is
not a published release; do not apply the old `0.0.6` artifact to a private source installation.

## Real-tailnet smoke to complete

1. In the guided installer, select **Private on all your devices — Tailscale**. On a clean VPS,
   verify explicit installation consent. Follow the login link, enable Device approval, approve
   the VPS, and acknowledge the certificate-name disclosure. Complete HTTPS consent if shown.
2. With Tailscale connected on an approved computer, open the printed setup link, register a
   passkey, and continue in the PWA. Confirm **Private · Tailscale** and the exact address.
   Reload, sign out, and sign in again.
3. On the authenticated computer, open **Connections → Devices → Link a device**. Scan that
   new QR from an approved phone on mobile data and register a separate passkey. Use the same
   HTTPS address from both devices. Repeat after closing the browser and signing in again.
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
