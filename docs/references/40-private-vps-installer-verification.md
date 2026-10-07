# Private VPS installer verification

This report records runtime evidence for [issue #48](https://github.com/Ic3b3rg/veduta/issues/48)
and the production/access separation in [ADR-0015](../adr/0015-vps-access-modes.md).
Runtime checks were performed on October 7, 2026.
The implementation is being verified on the `feat/private-vps-install` branch.

## Why the original command appeared frozen

The supplied VPS runs Ubuntu 26.04 with sudo-rs 0.2.13. With the original installer fed through
`cat install.sh | sudo bash`, the domain prompt's Bash reader entered a stopped `T+` process
state. Keystrokes and Ctrl+C were echoed without advancing the prompt. The original script
already read `/dev/tty`; blaming stdin consumption alone would be inaccurate.

The identical script, invoked as `sudo bash install.sh`, accepted the domain, advanced to the
email prompt, and exited normally on Ctrl+C. Ubuntu 24.04 with conventional sudo did not
reproduce the pipe failure. The new installer requires a downloaded file for interactive use
and tests the rejected pipe form under a real pseudo-terminal. Prompting no longer runs in
command-substitution subprocesses.

## Additional regressions found by running the installer

- Public HTTPS obtained a certificate but Fastify then crashed in `os.networkInterfaces()`
  (`uv_interface_addresses`, system error 97). The unit's address-family restriction omitted
  Linux `AF_NETLINK`. Allowing that family, without granting network administration capability,
  restored startup under the same hardened service.
- Reloading the PWA during an access-change restart could leave it showing cached Home without
  reconnecting. Initial connection failures now retry; pending access changes remain visible
  and poll until the committed service is available.
- An SSH server on a nonstandard port could be incorrectly advertised as port 22. Detection
  now precedes the default, with automated handoff coverage.

## Runtime environments and evidence

The real x86-64 Ubuntu 26.04 VPS was accessed using the owner's existing SSH agent. A prior
unrelated process occupied port 8788; it was left untouched and the guided installer offered 8789. The fresh installation built the production service, generated a vault key, pinned the
update root, and waited for a browser passkey. Chromium registered, refreshed, cleared its
session, and signed in again. The terminal wait completed successfully.

Socket checks showed the Gateway only on `127.0.0.1`; no new public 80/443 listener appeared.
The effective service retained its dedicated user, `ProtectSystem=strict`, `ProtectHome=yes`,
and `NoNewPrivileges=yes`. No ACME flow ran for Tunnel access.

An injected failure stopped a staged replacement on port 8790. The installer exited with a
failure, restored the original 8789 service, and preserved byte hashes of the old auth store,
vault key, update pinning, and onboarding state. A subsequent successful change exposed the
PWA reconnect bug described above. Repeating the change with the fix passed registration,
reload, and re-login in Chromium, and the terminal reported a verified committed change.
A real VPS reboot changed its boot ID, started the enabled service automatically, and retained
identical SHA-256 hashes for the current passkey store, vault key, update pinning, and onboarding
state. Socket inspection after reboot still showed only loopback application access.

Public access is tested in an isolated Ubuntu 24.04 systemd container using the real ACME
client and Let's Encrypt's [Pebble](https://github.com/letsencrypt/pebble) test CA. The CA
validates HTTP-01 against the container. After the address-family fix, a normally verified
HTTPS request returned production auth status. The test network has no published host ports;
it does not change the real VPS's public exposure. Browser tests use a virtual authenticator;
no personal passkey or provider secret is required.

The Public lab also completed passkey registration, reload, and re-login. An injected failure
in Public-to-Tunnel pairing restored trusted HTTPS and identical old auth/vault/onboarding
hashes. Successful Public-to-Tunnel and Tunnel-to-Public changes each required a new passkey,
passed the same browser journey, and committed from the waiting terminal. Public certificates
are scoped by domain to avoid replacing the old origin's certificate during a staged change.

## Review

The two independent code-review axes found and resolved these issues:

- Standards: failed rollback operations could be ignored by Bash's conditional errexit rules;
  rollback now checks configuration restoration and old Gateway readiness before cleaning up.
  Legacy custom data directories are retained, update-pinning documentation is consistent, and
  shared access status has one named type.
- Specification: Update access now offers editable existing values; effective SSH policy checks
  include per-connection Match rules, DisableForwarding, and PermitOpen. Unsupported pinned
  source is rejected before cleaning runnable files, with an explicit source-upgrade command.

The final suite includes a failed-restoration regression and verifies that candidate recovery
files are retained when restoring the old configuration fails. SSH authorized-key restrictions
and client reachability are ultimately verified by the actual generated forward; no SSH
private key is read by the installer.

## Repeating the checks

The completed `pnpm check` passed lint, formatting, typechecks, all 3,919 package tests, and
builds. Both code-review axes reported no remaining blocker after the fixes. Run `pnpm check`
to repeat the repository checks. The installer protocol suite includes preview purity,
invalid and missing flags, TTY pipe rejection, SSH port detection, occupied-port handling,
forwarding failure, and preservation of an installed origin. The production runtime test
starts and restarts the real entry point with fresh persistent data.

The opt-in `packages/e2e/tests/installer-smoke.spec.ts` exercises a clean operator-provided
installation while its CLI waits for pairing. Set `VEDUTA_INSTALLER_SMOKE_URL` to that temporary
setup URL. For Public access also set `VEDUTA_INSTALLER_SMOKE_MODE=public`; only an isolated test
CA may use `VEDUTA_INSTALLER_SMOKE_TEST_CA=1`, with certificate trust separately checked by curl.
The ordinary browser suite skips this test. Never use the fixture with a personal installation.

## Limits

Tunnel access is for a computer running an SSH forward; it does not provide the requested
private phone link. [Issue #49](https://github.com/Ic3b3rg/veduta/issues/49) owns Tailscale Serve,
its login, authorized-device verification, and phone testing. Public HTTPS lab verification
must not be presented as a public-domain deployment on the real VPS. The browser smoke stops at the working onboarding wizard; it does not claim a full personal
Model-connection onboarding journey. Existing onboarding route and UI suites cover the retained
steps. No personal Model connection was added during installer checks. The current stable `0.0.6` artifact predates
private access and must not be applied to this source candidate.
