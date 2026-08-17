# 036 — Restart the daemon after onboarding's deliberate clean exit

## Verified bug

Finishing onboarding deliberately exits the VPS daemon with status `0` so boot-time configuration
can be reloaded. Installer-generated systemd configuration uses `Restart=always`, but the checked-in
manual-install unit uses `Restart=on-failure`. A manually installed daemon therefore stays stopped
after successful onboarding, leaving the PWA on its restarting state indefinitely.

## Desired behavior

Every documented VPS installation path must supervise the deliberate onboarding restart the same
way. A clean exit requested by onboarding restarts the daemon, while the existing hardening,
graceful-shutdown, and self-update exit-code contracts remain intact.

## Acceptance criteria

- [ ] The checked-in systemd unit restarts after onboarding exits with status `0`.
- [ ] Installer-generated and manually installed units express the same restart contract.
- [ ] Unit documentation explains why a clean exit is restartable.
- [ ] A focused service-level or deterministic unit-file test guards the contract.
- [ ] Failure and self-update restart behavior remains unchanged.
- [ ] `pnpm check` passes.

## Out of scope

- Redesigning onboarding configuration reloads to avoid a process restart.
- Changing the Local VPS supervisor.
- Replacing systemd or the update supervisor wrapper.

## Blocked by

None — can start immediately.
