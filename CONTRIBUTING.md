# Contributing to Veduta

## Project status

Veduta is in the **design phase**: this repository currently contains the full design corpus (architecture, PRD, ADRs, research, issues) but **no code yet**. Implementation starts with [issue 001](issues/001-monorepo-scaffold.md).

## How to contribute today

1. **Read the design** — start with [README.md](README.md), then [ARCHITECTURE.md](ARCHITECTURE.md) and [PRD.md](PRD.md). The glossary in [CONTEXT.md](CONTEXT.md) defines the project's canonical terms: use them (and avoid the listed alternatives) in every discussion, issue, and line of code.
2. **Challenge the design** — open a GitHub issue if you spot a flaw. Decisions are recorded in [docs/adr/](docs/adr/) with their rationale and the evidence in [docs/references/](docs/references/); challenge the reasoning, not just the conclusion.
3. **Pick up an implementation issue** — the v1 work is broken down in [issues/](issues/) with dependency order and acceptance criteria. Comment on the corresponding GitHub issue before starting so work doesn't get duplicated.

## Development setup (defined by issue 001, evolving)

The intended contributor experience — this is a **requirement**, not an aspiration:

```bash
git clone https://github.com/Ic3b3rg/veduta && cd veduta
pnpm install
pnpm dev        # daemon on localhost (dev profile) + PWA with hot reload
```

- **Dev profile**: plain HTTP on loopback, a dev token instead of passkeys, no domain or ACME required. Production hardening (TLS, WebAuthn) must never be a prerequisite for local development.
- **Mock LLM provider**: the daemon runs with a deterministic mock provider so you can develop and run tests without any API key. Real providers (BYOK) are opt-in via env.
- **Seed data**: `pnpm dev` boots with an example Space and Surfaces so the Home is never empty on first run.
- `pnpm test`, `pnpm lint`, `pnpm typecheck` must pass before any PR.

## Ground rules

- **English only** in the repo: docs, code, comments, commit messages, issues.
- **Respect the glossary** ([CONTEXT.md](CONTEXT.md)) and the **anti-requirements** ([ARCHITECTURE.md §7](ARCHITECTURE.md)): no agent hierarchies, no free-form generated HTML, no knowledge graphs, no rich content in messenger Bridges.
- **One issue, one PR**, small and reviewable. Every PR states which acceptance criteria it satisfies.
- Architectural changes require an ADR (see [docs/adr/](docs/adr/) for the format): state the trade-off, not just the choice.
- Tests accompany code. For test data with partial objects, prefer `@total-typescript/shoehorn` over `as` casts.

## License

MIT. By contributing you agree your contributions are licensed under the same terms.
