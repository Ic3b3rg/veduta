# Veduta

An open source, self-hosted **visual personal Agent**. Open Home to see your life areas as
**Spaces**, each with persistent **Surfaces** for plans, trackers, lists, and ongoing work.
Talk to one Agent to create and update them; come back later and pick up where you left off.

> _Veduta_: an old Italian word for a detailed, wide painting of a city — the whole city at a glance, like Canaletto's vedute. Open it, and see.

[Install](#install-on-a-vps) · [Try locally](#try-it-on-your-computer) ·
[First steps](#your-first-surface) · [Updates](#updates) · [Documentation](#documentation)

Veduta is early **alpha** software. The supported installation path below uses a Linux VPS
and a browser; the Local VPS profile lets you try the core journey on your own computer.

## Choose where to start

| You want to…                                                   | Start here                                          |
| -------------------------------------------------------------- | --------------------------------------------------- |
| Keep Veduta running and use it from your computer or phone     | [Install on a VPS](#install-on-a-vps)               |
| Try passkeys, onboarding, and Surfaces without a VPS or domain | [Try it on your computer](#try-it-on-your-computer) |
| Work on the code with seed data and a mock provider            | [Development](#development)                         |

## Install on a VPS

### 1. Before you begin

Use a Linux VPS with Ubuntu, systemd, SSH access, `sudo`, and `curl`, and a browser that
supports **passkeys**. Choose **x86-64** for the complete signed-update path; ARM64 update
runtime support is tracked in [issue #44](https://github.com/Ic3b3rg/veduta/issues/44).

For **private access from your computer and phone**, install [Tailscale](https://tailscale.com/download)
on both devices and sign in with the same personal account. Enable **Device approval** in
[Tailscale's device settings](https://login.tailscale.com/admin/settings/device-management)
and approve your devices in [Machines](https://login.tailscale.com/admin/machines). Keep this
personal network limited to the people and devices you want to allow.

You do not need to buy a domain, edit DNS records, or open public web ports. Tailscale supplies
the private HTTPS address; Veduta still requires a passkey. You will connect a
[Model connection](#model-connections) in the browser after installation.

### 2. Run the installer on the VPS

Log in over SSH and paste this command **on the VPS**:

```sh
curl -fsSLo veduta-install.sh \
  https://raw.githubusercontent.com/Ic3b3rg/veduta/main/deploy/install.sh &&
sudo env SSH_CONNECTION="$SSH_CONNECTION" bash veduta-install.sh --access tailnet
```

This guide follows the current source installer. The published `v0.0.6` installer only
supports Public access; do not substitute that tag when trying private access.

Confirm the plan and let the installer install Tailscale if needed. Open its login link using
the same account, approve the VPS in **Machines**, and confirm that Device approval is enabled.
If Tailscale asks to enable HTTPS, follow its link once and return to the terminal.
The `*.ts.net` certificate hostname is visible in public certificate logs; access to Veduta
and its traffic stays private. The installer explains this before enabling HTTPS.

The installer sets up the
pinned Node.js and pnpm versions, the encrypted vault, signed updates, and the systemd service.
You do not need to copy a signing key. Optional ChatGPT subscription support is installed too.

Download the script before running it: piping an interactive installer into `sudo` can leave
its prompts unresponsive on Ubuntu with `sudo-rs`. If a stage fails, the installer prints the
recovery action and a log location. `--preview` shows the plan without making changes.

### 3. Open the setup link

Keep Tailscale connected on your computer or phone. Open the printed **HTTPS link**, or scan
the QR code with your phone. This same address works on both devices, including away from home.
An unapproved device cannot reach it. The installer checks private HTTPS before printing it.

1. Choose **Register passkey** and complete your browser's prompt. The installer confirms
   registration and you continue in the browser. The setup link expires after 60 minutes.
2. Review an optional OpenClaw or Hermes import if one was detected, or start fresh.
3. Confirm **Browser access**, add your **Model connection**, and select its models.
4. Create your first **Space**.
5. Configure optional integrations or choose **Skip**, then **Finish**.

Calendar push updates require a public callback, so that optional step is unavailable on
private access. Saved connection details are preserved when access changes.

If you close the installer or the setup link expires, run **`sudo veduta setup`** on the VPS.
It recovers your link without rebuilding Veduta. Closing the setup wait does not stop the service.
Use **`sudo veduta access`** to repair or change access later; a new address requires a new
passkey, and a failed change restores the previous access without replacing application data.

### Other access options

Use `--access tunnel` for computer-only access through the exact SSH command printed by the
installer. Keep that forward running and use its localhost URL. Use `--access public` if you
want your own domain, with DNS pointing to the VPS, ports 80/443, and a certificate contact email.
All modes use the same production service and mandatory passkeys. Without `--access`, the
guided installer preselects Tailnet when already connected to Tailscale, otherwise Tunnel.

If private access stops working, reconnect Tailscale and check device approval. Recover from
SSH with `sudo veduta access` → **Repair**; after a changed Tailscale hostname, choose **Update
access** and register a new passkey. See [long-term operation](deploy/README.md#tailnet-access)
for device removal, key expiry, and the privacy boundary.

Bookmark your address. On a phone using Public access, choose **Add to Home Screen** or
**Install app** when available. The VPS keeps running when you close the browser.

## Your first Surface

With a real Model connection selected:

1. Open **Health** from Home and send: **“Log my weight today as 74 kg and show a weight tracker.”**
2. Wait for the Agent's reply and the resulting Surface. Send a follow-up to update it, such
   as **“Correct today's weight to 73.8 kg.”**
3. Refresh the page and reopen Health. Check that the tracker and Chat timeline retain the
   result. This is a useful first check that configuration and persistence work together.
4. Try a plan or checklist next. A confirmed Automation can keep recurring work in that Space;
   use **Pin** when you want to keep a Surface stable and prominent.

Local runs can use a deterministic mock provider to exercise the interface without a paid
model. Its replies follow fixed examples; connect a real provider to evaluate the Agent's
responses to your own requests.

## Try it on your computer

The **Local VPS profile** runs the passkey and onboarding journey on macOS or Linux, without
public DNS or a VPS. Install Git, **Node.js 24.11.1** (the version in `.node-version`), and
Corepack first, then:

```sh
git clone --branch v0.0.6 --depth 1 https://github.com/Ic3b3rg/veduta.git
cd veduta
corepack enable
corepack prepare pnpm@10.28.0 --activate
pnpm install --frozen-lockfile
pnpm local-vps --base-dir ~/.veduta-v0.0.6
```

Open the printed **`http://localhost:8788/setup?code=…`** link. Use `localhost` throughout:
`127.0.0.1` is a different passkey origin. Register a passkey, walk the same wizard, and either
connect a real provider or select the **built-in mock provider** checkbox for a key-free trial.
If you want ChatGPT, accept the terminal's first-run offer to provision Codex; you can also
[provision it later](deploy/local-vps.md#chatgpt-subscription-codex).

Keep the terminal running. **Ctrl-C** stops Veduta; run
`pnpm local-vps --base-dir ~/.veduta-v0.0.6` again to resume with the same data. This separate
directory leaves any earlier local trial untouched. This profile does not configure the public update feed.
See the [Local VPS guide](deploy/local-vps.md) for ports, separate data directories, and recovery.

## Updates

For a VPS installed with this guide, use the signed updater:

1. Open the **System Space**, find **Updates**, and choose **Check now**.
2. Read the offered version and release notes, then choose **Apply update**.
3. Wait for Veduta to restart, then refresh and check your existing Spaces and Surfaces.

The updater verifies the release, backs up your data before migration, and checks the new
version before reporting success. A failed activation automatically restores the previous
version and its data.

A fresh source installation reports the baseline version `0.0.0` until its first signed
update. This installer change requires a newer release than `0.0.6`; do not apply `0.0.6` to a
private source installation, since that release only supports Public access. If Updates is
unconfigured, follow the [update setup guide](deploy/README.md#updates); fresh upstream
installations automatically pin the bundled public root key.

Published builds and notes are in [GitHub Releases](https://github.com/Ic3b3rg/veduta/releases).
The signing and verification procedure is public in [RELEASING.md](RELEASING.md).

## Troubleshooting

| What you see                     | What to do                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The installer only prints a plan | Run the downloaded file from an interactive SSH terminal. Remove `--preview` when ready to install.                                                         |
| The private link does not open   | Connect Tailscale on the device, check that it and the VPS are approved, then use `sudo veduta access` → Repair over SSH.                                   |
| HTTPS setup does not complete    | Check the domain's A/AAAA records and access to ports 80/443. Follow the installer's retry command after correcting them.                                   |
| Setup was interrupted            | Reopen the setup page; the wizard resumes saved progress. If the installer failed, use the exact rerun command it printed.                                  |
| A local passkey fails            | Open the printed `http://localhost:8788` URL, using the same origin where the passkey was registered.                                                       |
| ChatGPT is unavailable           | Run the Codex provisioning command printed by the installer. For a local run, follow the [Local VPS guide](deploy/local-vps.md#chatgpt-subscription-codex). |
| An update fails                  | Read the Updates Surface's reason. Veduta keeps or restores the previous release; inspect the service logs if it does not return.                           |

On the VPS, inspect the service with:

```sh
sudo systemctl status veduta.service
sudo journalctl -u veduta.service -n 50 --no-pager
```

For backups and recovery, use the [deployment guide](deploy/README.md). Keep a separate copy
of `/etc/veduta/vault.key`: it is required to decrypt your secrets and backups and is
intentionally excluded from the encrypted backup archive.

## Model connections

The Gateway routes model calls through a **Model connection**, using either a provider subscription
or BYOK:

- **ChatGPT subscription** uses managed device authorization through an exactly pinned
  `codex app-server` child. The adapter carries allowed `ToolDef` calls through Codex
  `dynamicTools`; Veduta's `AgentRunner` still validates and executes every tool, applies trust
  rules, writes the Event log, and owns Surface changes.
- **BYOK** supports Anthropic, OpenAI, and OpenRouter API keys through the same connection lifecycle.

Claude subscription remains visible but unavailable until Anthropic publishes or approves a
third-party subscription contract; Anthropic BYOK remains supported. The
[real-account smoke](docs/references/11-model-connections-manual-smoke.md) confirms ChatGPT
authorization, model selection, inference, and Surface creation and patching without an API key.
[Connection parity](CONTEXT.md) is enforced by one primary inference contract: every routable
adapter receives the same allowed tool definitions, while an adapter without that contract is
unavailable. Deterministic BYOK/Codex fixtures cover Surface authoring, Space memory, Templates,
Automations, Workers, and trust-wrapped actions.

The durable boundaries live in
[ADR-0014](docs/adr/0014-subscription-inference-boundary.md) and
[ADR-0016](docs/adr/0016-primary-agent-connections-author-surfaces.md); see the
[security contract](docs/SECURITY.md) and the
[original protocol capture](docs/references/13-codex-dynamic-tools-0.146.1.md) and
[Codex 0.160.0 compatibility check](docs/references/codex-0.160-compatibility.md) for operational
and protocol details.

## Development

From a checkout with the Node.js and pnpm versions above:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open **http://localhost:5173**; the daemon runs at **http://127.0.0.1:8787**. This is the
**Loopback profile**, with seed data, a deterministic mock provider, and no passkey onboarding.
Use the Local VPS profile above to rehearse the product setup journey.

Run `pnpm check` before submitting changes. Contribution conventions are in
[CONTRIBUTING.md](CONTRIBUTING.md); work specifications and acceptance criteria live in
[GitHub Issues](https://github.com/Ic3b3rg/veduta/issues).

## Documentation

| Source                                   | Contents                                                              |
| ---------------------------------------- | --------------------------------------------------------------------- |
| [VPS deployment](deploy/README.md)       | Installer options, service operations, backups, recovery, and updates |
| [Local VPS profile](deploy/local-vps.md) | Local passkeys, onboarding, configuration, and restart behavior       |
| [RELEASING.md](RELEASING.md)             | Signed releases, verification, and key recovery                       |
| [ARCHITECTURE.md](ARCHITECTURE.md)       | Architecture, diagrams, and key flows                                 |
| [PRD.md](PRD.md)                         | Product requirements and scope                                        |
| [CONTEXT.md](CONTEXT.md)                 | Domain glossary                                                       |
| [Security](docs/SECURITY.md)             | Trust model and deployment boundaries                                 |
| [Architectural decisions](docs/adr/)     | Decisions and their rationale                                         |
| [Research](docs/references/)             | Evidence supporting product and technical decisions                   |

## Foundational decisions

1. **Home-first, not chat-first** — [ADR-0001](docs/adr/0001-home-first.md)
2. **A single agent loop; hierarchy lives in the data (Spaces), not in agents** — [ADR-0002](docs/adr/0002-single-agent-spaces.md)
3. **Surfaces = a tree of declarative Atoms from a closed catalog, never free-form HTML** — [ADR-0003](docs/adr/0003-declarative-atoms.md)
4. **TypeScript everywhere; pi-agent-core runtime wrapped behind our own interfaces** — [ADR-0004](docs/adr/0004-typescript-pi-agent-core.md)
5. **Event-driven proactivity: push events + one-shot timers + pre-filters; Heartbeat only as a safety net** — [ADR-0005](docs/adr/0005-event-driven-proactivity.md)
6. **File-based memory: files are the truth, indexes are disposable** — [ADR-0006](docs/adr/0006-file-based-memory.md)
7. **Three trust levels + dual context protect typed product paths; general execution remains an explicit, audited Agent capability** — [ADR-0007](docs/adr/0007-trust-levels.md) and [ADR-0026](docs/adr/0026-skills-may-drive-general-tool-execution.md)
8. **VPS-first, passkeys, and Gateway-owned Model connections; PWA as the primary client, messengers as thin Bridges** — [ADR-0008](docs/adr/0008-vps-passkey-byok.md) and [ADR-0014](docs/adr/0014-subscription-inference-boundary.md)
9. **A Local VPS profile keeps `pnpm dev` a lightweight loopback profile while still letting core production flows be rehearsed locally** — [ADR-0009](docs/adr/0009-local-vps-profile.md)

10. **Personal Mailbox access is pull-based through passive Gmail and Skill-driven Himalaya connections** — [ADR-0024](docs/adr/0024-pull-based-personal-mailbox.md)
11. **First-party Skills may guide direct CLI/API execution; generative Surfaces are the durable product boundary** — [ADR-0026](docs/adr/0026-skills-may-drive-general-tool-execution.md)
