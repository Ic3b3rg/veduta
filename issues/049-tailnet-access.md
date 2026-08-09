# 049 — Tailnet access: private multi-device PWA through Tailscale Serve

## Context

Tunnel access keeps a VPS private but is device-local: each browser session needs an SSH
forward, and a phone cannot use the installer's desktop tunnel. Tailscale Serve can proxy a
loopback-only service to a stable HTTPS `*.ts.net` origin available only inside the user's
tailnet. This is the private multi-device path recommended by
[OpenClaw](https://docs.openclaw.ai/gateway/remote) and supported by
[Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve).

[ADR-0015](../docs/adr/0015-vps-access-modes.md) defines Tailnet access as a third VPS access
mode, keeps Veduta passkeys mandatory, accepts the bounded public disclosure of the certificate
hostname, and forbids automatic fallback to a public listener.

## Goal

A user can guide an existing or new VPS into Tailnet access, then use the same private Veduta
PWA from an authorized desktop browser and phone through HTTPS and passkeys, with no public
application port and no manual Tailscale configuration.

## What to build

- Extend the installer and its Update access flow with **Private on all your devices —
  Tailscale**. If Tailscale is already installed and connected, preselect Tailnet access; if it
  is absent, retain Tunnel access as the default. Never preselect Public access.
- With explicit consent, install Tailscale through its supported distribution path when absent.
  Support an already-connected node or an interactive login URL that the installer waits on and
  verifies. Do not request, store, or manage Tailscale auth keys.
- Keep the Gateway bound to loopback and configure persistent Tailscale Serve HTTPS as the only
  ingress. Never enable Funnel, never trust Tailscale identity headers as a replacement for a
  Veduta session, and keep passkey registration mandatory.
- Disclose before activation that the `*.ts.net` certificate hostname may appear in public
  Certificate Transparency logs while the service and traffic remain tailnet-only.
- Own only Veduta's Serve route. Use HTTPS 443 when free; if it conflicts, offer a safe free
  HTTPS port as the editable default and persist the resulting origin. Never reset or overwrite
  unrelated Serve/Funnel configuration, and remove only Veduta's route when changing modes.
- Verify Tailscale connection state, MagicDNS/HTTPS readiness, a valid Serve certificate, the
  loopback Gateway, absence of Funnel on Veduta's endpoint, and an end-to-end request before
  committing the access change.
- Reuse the staged access migration from issue 048: preserve all data, register a passkey for the
  new RP ID/origin, commit only after verification, and roll back to the previous mode on any
  failure. Only one PWA origin is active after the transaction.
- Restore link plus QR for Tailnet access. Explain that every desktop or mobile device must be
  authorized in the same tailnet before it can reach the passkey screen; devices outside the
  tailnet cannot reach Veduta at all.
- Fail closed when Tailscale disconnects, Serve loses its route, or the node hostname changes.
  Keep Veduta on loopback, report an exact diagnosis through the administrative access command,
  and require repair or guided reconfiguration over SSH. Never switch to Public or Tunnel
  access automatically.

## Acceptance criteria

- [ ] **Guided new install:** on a supported VPS without Tailscale, selecting Tailnet access
      obtains explicit install consent, completes interactive Tailscale login, configures Serve,
      registers a Veduta passkey, and reaches the PWA without a manual config edit or auth key.
- [ ] **Existing-tailnet default:** on a VPS already connected to Tailscale, the guided installer
      detects and preselects Tailnet access, reuses the account safely, and does not prompt for
      redundant values.
- [ ] **Desktop and phone:** an authorized desktop browser and an authorized phone can open the
      same stable HTTPS URL and authenticate with Veduta passkeys; a device outside the tailnet
      cannot reach the endpoint.
- [ ] **No public ingress:** network and Serve-status checks prove the Gateway remains on
      loopback, Veduta's endpoint is Serve rather than Funnel, and no public application port is
      opened.
- [ ] **Configuration coexistence:** a fixture with an unrelated existing Serve route is
      preserved byte-for-byte; Veduta selects or confirms a non-conflicting endpoint, and later
      removal touches only Veduta's route.
- [ ] **Safe migration:** Tunnel-to-Tailnet and Public-to-Tailnet changes preserve all data and
      Model connections, require a new-origin passkey, and roll back both Veduta and Serve state
      after an injected certificate, reachability, or pairing failure.
- [ ] **Fail closed:** simulated Tailscale logout, Serve removal, and hostname drift never expose
      the Gateway or choose another access mode; diagnostics identify the failure and the exact
      SSH recovery action.
- [ ] Automated tests use a deterministic Tailscale CLI/status fake for every state transition;
      a documented real-tailnet smoke covers HTTPS, QR, passkey, desktop, phone, reboot
      persistence, and the Certificate Transparency disclosure.

## Out of scope

- Tailscale Funnel or any public fallback.
- Tailscale auth-key provisioning or unattended tailnet enrollment.
- Zerotier, WireGuard, Cloudflare Tunnel, or other private-access providers.
- Multiple simultaneously active PWA origins.

## Blocked by

[048 — Guided VPS installer with Tunnel and Public access](048-guided-vps-access-installer.md).
