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

Have these ready:

- A clean **Ubuntu 22.04 or 24.04** VPS with systemd, SSH access, `sudo`, and `curl`.
  Choose **x86-64** for the complete signed-update path. The installer also accepts ARM64,
  but signed Node runtime downloads on ARM64 remain limited by
  [issue #44](https://github.com/Ic3b3rg/veduta/issues/44).
- A domain such as `veduta.example.com`, with its DNS A record pointing to the VPS. If you
  publish an AAAA record, it must reach the same VPS over IPv6. TCP ports **80 and 443** must
  be available and reachable for HTTPS setup and browser access.
- An email address for the HTTPS certificate and a browser that supports **passkeys**.
- A [Model connection](#model-connections): a ChatGPT subscription or an Anthropic, OpenAI,
  or OpenRouter API key. You connect it in the browser during setup.

The current installer uses **Public access**. Guided private access is tracked separately in
[issue #48](https://github.com/Ic3b3rg/veduta/issues/48) (SSH Tunnel) and
[issue #49](https://github.com/Ic3b3rg/veduta/issues/49) (Tailnet). To try Veduta without a domain
now, use the [Local VPS profile](#try-it-on-your-computer).

### 2. Run the installer on the VPS

Log in to the VPS over SSH, then run these commands **on the VPS**. They install the
`v0.0.6` source and pin the [public root key](docs/keys/root.pub) for future signed updates:

```sh
curl -fsSLo veduta-root.pub \
  https://raw.githubusercontent.com/Ic3b3rg/veduta/v0.0.6/docs/keys/root.pub &&
curl -fsSL https://raw.githubusercontent.com/Ic3b3rg/veduta/v0.0.6/deploy/install.sh | \
  sudo bash -s -- --ref v0.0.6 --update-root-key "@$PWD/veduta-root.pub"
```

Enter your domain and certificate email when prompted. The installer installs the pinned
Node.js and pnpm versions, builds Veduta, creates its service account and encrypted vault,
starts the systemd service, and prints a setup link and QR code. It also provisions the
pinned Codex binary used by the ChatGPT subscription Model connection.

The root key is public; no signing secret is needed to install Veduta. Keep the
`--update-root-key` option: omitting it on a fresh install leaves signed updates unconfigured.
For a plan with no installation changes, add `--preview` to the command. An unattended run
also needs `--apply --domain veduta.example.com --email you@example.com`; without a terminal
or `--apply`, the installer only previews the plan.

### 3. Finish setup in your browser

1. Open the setup link, or scan the QR code, and choose **Register passkey**. Complete your
   browser's passkey prompt. The initial setup code expires after 60 minutes.
2. If an OpenClaw or Hermes installation was detected, review the optional migration preview
   before applying it. Otherwise, continue with a fresh setup.
3. Confirm the domain, then add your **Model connection** and select its models. Authorize
   ChatGPT through the displayed provider flow, or enter a supported API key in the form.
4. Create your first **Space**; Health is a useful starting point for the example below.
5. Configure optional integrations or choose **Skip**, then **Finish**. Veduta restarts and
   the wizard waits for Home to become available.

Bookmark your HTTPS address. On a phone, use your browser's **Add to Home Screen** or
**Install app** action when available. The VPS keeps running when you close the browser.

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
update. Applying the offered `0.0.6` release installs the versioned build. If Updates is
unconfigured, follow the [update setup guide](deploy/README.md#updates); the installation
command above already supplies the root key.

Published builds and notes are in [GitHub Releases](https://github.com/Ic3b3rg/veduta/releases).
The signing and verification procedure is public in [RELEASING.md](RELEASING.md).

## Troubleshooting

| What you see                     | What to do                                                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The installer only prints a plan | Run it from an interactive SSH terminal, or supply `--apply`, `--domain`, and `--email`. Remove `--preview` when ready to install.                          |
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
