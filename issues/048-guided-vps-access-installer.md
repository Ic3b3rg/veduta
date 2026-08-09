# 048 — Guided VPS installer with Tunnel and Public access

## Context

The production installer currently equates the VPS profile with a public domain and ACME. The
only no-domain path is a development-oriented Local VPS runner plus hand-written systemd and
SSH commands. That path is easy to get wrong, is not represented in the installer's stage
protocol, and turns the safest personal deployment into an undocumented workaround.

[ADR-0015](../docs/adr/0015-vps-access-modes.md) separates production execution from browser
access. A real VPS keeps the same hardened service, persistent data, updates, onboarding, and
passkey authentication whether the browser reaches it through a public domain or an SSH local
forward. OpenClaw documents the same loopback-plus-SSH topology as its universal remote-access
[fallback](https://docs.openclaw.ai/gateway/remote); Hermes also recommends a loopback bind plus
a tunnel for a private remote
[dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard).

## Goal

On a supported clean Ubuntu VPS, a user without a domain reaches first passkey registration in
under 15 minutes with one guided installer command on the server and one exact SSH command on
the client, without editing configuration, exposing a public port, or reusing the Local VPS
profile.

## What to build

- Keep one canonical installer running on the destination server. Its interactive first choice
  is the access mode:
  - **Tunnel access — no domain required** (recommended and preselected).
  - **Public access — domain and ACME email required**.
- Give every prompt a detected or safe default and make Enter accept it. Ask only for values
  that cannot be inferred. Show one concise plan and confirmation before mutation, retain
  preview-only behavior for non-interactive runs, and support explicit unattended
  `--access tunnel` and `--access public` flows.
- In Tunnel access, install the same production Gateway under the dedicated hardened systemd
  service and existing data/update layout, but bind its application port only to
  `127.0.0.1`. Do not request a domain, run ACME, bind a public application listener, or switch
  to the Local VPS profile.
- Keep passkey authentication mandatory. Use the stable `http://localhost:<port>` WebAuthn
  origin reached through the local forward; Tunnel access is a transport choice, not an
  unauthenticated mode.
- Default both ends of the tunnel to port 8788 and keep the chosen browser origin stable across
  reruns and updates. If the port is occupied, identify the conflict and offer a free port as an
  editable default instead of silently changing it.
- Detect the invoking SSH user and destination address when possible and show them as editable
  defaults. When invoked from a provider console rather than SSH, ask for the SSH target and
  verify that it can support the handoff. Refuse Tunnel access with an exact recovery action if
  no usable SSH path exists.
- At first boot, print one complete foreground local-forward command with no placeholders and a
  prominent “run this on your computer, not on the VPS” instruction, followed by a clickable
  localhost setup URL. Do not print a misleading QR in Tunnel access; retain link plus QR for
  Public access.
- Keep the terminal installer in a `Waiting for passkey registration` state. Exit successfully
  once the first passkey is registered and tell the user to continue onboarding in the PWA.
  Interrupting this wait must not stop Veduta; a stable administrative setup command must
  regenerate or reprint a valid handoff later.
- Make reruns installation-aware and idempotent. Present current values as defaults and offer
  Repair, Update access, or Exit. An access change preserves every Space, Event log, Model
  connection, vault secret, and update state; it stages and verifies the new origin and a new
  passkey before committing, and rolls back completely on failure.
- Extend the machine-readable stage protocol and diagnostics to identify the selected access
  mode, waiting handoff, completion, and exact repair action without leaking bootstrap codes or
  secrets.
- Preserve the existing Public access behavior and its security posture as a regression-tested
  branch of the same installer.

## Acceptance criteria

- [ ] **Timed no-domain journey:** on a clean supported Ubuntu VPS reached over SSH, the bare
      guided installer defaults to Tunnel access and reaches first passkey registration in
      under 15 minutes using exactly one server command and the generated client command, with
      no hand-edited file.
- [ ] **No exposure:** a socket/firewall probe proves the Gateway application port listens only
      on `127.0.0.1`; the host exposes no new public HTTP/HTTPS port and no ACME request occurs.
- [ ] **Real production profile:** Tunnel access uses the hardened systemd service, production
      auth, persistent data, and update layout; restart and reboot preserve service and data.
- [ ] **Exact handoff:** an SSH session produces a correct placeholder-free command and localhost
      URL, a provider-console run requests only the missing SSH target, and both clearly
      distinguish the client terminal from the VPS terminal.
- [ ] **Pairing recovery:** successful passkey registration completes the terminal wait;
      interrupting the wait leaves the service healthy, and the administrative setup command
      later issues a usable handoff without reinstalling.
- [ ] **Public regression:** Public access still obtains HTTPS for a supplied domain, prints its
      QR, registers a passkey, and completes the existing onboarding flow.
- [ ] **Non-destructive reconfiguration:** switching between Public and Tunnel access preserves
      all application data, requires the correct new-origin passkey, commits only after a live
      verification, and restores the old access on an injected failure.
- [ ] Preview, unattended flags, reruns, occupied-port handling, stage events, and failure
      messages are covered by automated installer tests; a real-VPS smoke run documents the
      public and tunnel journeys.

## Out of scope

- A native client or background SSH tunnel manager.
- Phone access through an SSH tunnel.
- Tailscale or other private-network access; [issue 049](049-tailnet-access.md) adds that as a
  separate slice.
- Model authorization or routing UX; [issue 047](047-model-connections.md) owns the PWA Model
  connection journey.

## Blocked by

None — builds on completed issues [005](005-auth-tls-passkey.md),
[019](019-onboarding-wizard.md), and [043](043-self-update.md), and on
[ADR-0015](../docs/adr/0015-vps-access-modes.md).
