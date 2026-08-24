# Veduta

> _Veduta_: an old Italian word for a detailed, wide painting of a city — the whole city at a glance, like Canaletto's vedute. Open it, and see.

An open source, self-hosted, **home-first** personal agent: the primary interface is not a chat but a home of persistent Surfaces per life area, proactively maintained by a single agent. Chat is an ever-present input that modifies the Surfaces.

**Thesis**: a personal agent with a real home beats a personal agent inside a chat (Telegram/WhatsApp). The market gap is verified: no product shipped as of mid-2026 has agent-owned, agent-updated Surfaces for life areas ([references](docs/references/02-competitor-home-first.md)).

## Documentation map

| File                                 | Contents                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)   | The full architecture picture, with diagrams and key flows                   |
| [PRD.md](PRD.md)                     | Product Requirements: problem, target, v1 scope, success criteria            |
| [CONTEXT.md](CONTEXT.md)             | Domain glossary (the project's ubiquitous language)                          |
| [docs/SECURITY.md](docs/SECURITY.md) | Security and trust model (hardened against external content)                 |
| [docs/adr/](docs/adr/)               | The architectural decisions, one per file, with the rationale                |
| [docs/references/](docs/references/) | Research supporting product, architecture, security, runtime, and operations |
| [issues/](issues/)                   | The v1 work broken into implementable issues, with acceptance criteria       |

## Foundational decisions (details in the ADRs)

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
[pinned protocol capture](docs/references/13-codex-dynamic-tools-0.146.1.md) for operational and
protocol details.

## Development

`pnpm install && pnpm dev` starts the Loopback profile with seed data and a deterministic mock
provider, so no VPS, domain, or API key is required. Current work and dependency order live in the
[issue specifications](issues/README.md) and their mirrored
[GitHub issues](https://github.com/Ic3b3rg/veduta/issues).

For a production-like local rehearsal — real passkey login, egress enforcement, persistent config — instead of the lightweight loopback profile, run `pnpm local-vps`; see [deploy/local-vps.md](deploy/local-vps.md).
