# Veduta

> *Veduta*: an old Italian word for a detailed, wide painting of a city — the whole city at a glance, like Canaletto's vedute. Open it, and see.

An open source, self-hosted, **home-first** personal agent: the primary interface is not a chat but a home of persistent Surfaces per life area, proactively maintained by a single agent. Chat is an ever-present input that modifies the Surfaces.

**Thesis**: a personal agent with a real home beats a personal agent inside a chat (Telegram/WhatsApp). The market gap is verified: no product shipped as of mid-2026 has agent-owned, agent-updated Surfaces for life areas ([references](docs/references/02-competitor-home-first.md)).

## Documentation map

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | The full architecture picture, with diagrams and key flows |
| [PRD.md](PRD.md) | Product Requirements: problem, target, v1 scope, success criteria |
| [CONTEXT.md](CONTEXT.md) | Domain glossary (the project's ubiquitous language) |
| [docs/SECURITY.md](docs/SECURITY.md) | Security and trust model (hardened against external content) |
| [docs/adr/](docs/adr/) | The architectural decisions, one per file, with the rationale |
| [docs/references/](docs/references/) | The 7 research studies conducted (SOTA, competitors, academic evidence, runtime) |
| [issues/](issues/) | The v1 work broken into implementable issues, with acceptance criteria |

## Foundational decisions (details in the ADRs)

1. **Home-first, not chat-first** — [ADR-0001](docs/adr/0001-home-first.md)
2. **A single agent loop; hierarchy lives in the data (Spaces), not in agents** — [ADR-0002](docs/adr/0002-single-agent-spaces.md)
3. **Surfaces = a tree of declarative Atoms from a closed catalog, never free-form HTML** — [ADR-0003](docs/adr/0003-declarative-atoms.md)
4. **TypeScript everywhere; pi-agent-core runtime wrapped behind our own interfaces** — [ADR-0004](docs/adr/0004-typescript-pi-agent-core.md)
5. **Event-driven proactivity: push events + one-shot timers + pre-filters; Heartbeat only as a safety net** — [ADR-0005](docs/adr/0005-event-driven-proactivity.md)
6. **File-based memory: files are the truth, indexes are disposable** — [ADR-0006](docs/adr/0006-file-based-memory.md)
7. **Three trust levels + dual context for external content** — [ADR-0007](docs/adr/0007-trust-levels.md)
8. **VPS-first, passkeys, BYOK; PWA as the primary client, messengers as thin Bridges** — [ADR-0008](docs/adr/0008-vps-passkey-byok.md)

## Status

2026-07-03 — Design phase complete (grilling session). Next step: issue `001-monorepo-scaffold`.
