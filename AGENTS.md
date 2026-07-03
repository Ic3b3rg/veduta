# AGENTS.md

Veduta is an open source, self-hosted, home-first personal agent: persistent Surfaces per life
area in a PWA, maintained by a single agent loop. pnpm TypeScript monorepo. This file is the
single source of truth for coding agents; `CLAUDE.md` just imports it.

## Commands

- Install: `pnpm install` — pnpm only, never npm or yarn
- Dev: `pnpm dev` → daemon on `http://127.0.0.1:8787` + PWA on `http://localhost:5173` (mock
  LLM provider and seed data — no VPS, domain, or API key required, by design)
- Test all: `pnpm test` · one package: `pnpm --filter @veduta/daemon test` · one file:
  `pnpm --filter @veduta/daemon test -- src/server.test.ts`
- Before finishing any change, run: `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`

## Hard rules

- Use the canonical vocabulary from `CONTEXT.md` (Space, Surface, Atom, fast path, quarantined
  reader…) in code, comments, and docs. The `_Avoid_` terms listed there are banned.
- Respect the anti-requirements (`ARCHITECTURE.md` §7): no agent hierarchies, no free-form
  generated HTML in Surfaces, no knowledge graphs, no rich content in messenger Bridges.
- Never import `pi-agent-core` outside the AgentRunner wrapper (ADR-0004). The daemon and
  workers talk only to our own interfaces (`AgentRunner`, `ModelRef`, `ToolDef`, `SessionStore`).
- Every fast-path mutation must append to the Space's Event log (ADR-0003): the Agent must find
  user interactions before reasoning about a Space. No silent state changes.
- Validate every Surface with `@veduta/protocol` schemas before persisting or rendering.
  Unimplemented Atom types render visibly (`UnknownAtom`), never crash and never disappear.
- English only: code, comments, commit messages, issues, docs.
- Never add `Co-Authored-By` or any AI-signature trailer to commits.
- Do not edit `pnpm-lock.yaml` by hand; do not commit generated output (`dist/`, coverage).

## Repo map

- `packages/protocol` — shared zod schemas (Space, Surface, Atom tree, actions, patches).
  Zero runtime deps besides zod. Everything crossing the daemon↔client boundary is defined here.
- `packages/daemon` — the Gateway: Fastify HTTP + chat WebSocket, store, seed, mock provider.
  Grows into Spaces engine, scheduler, event ingestion, trust layer (issues #4–#17).
- `packages/catalog` — React renderers for the Atom catalog. React is a peer dependency;
  no daemon imports.
- `packages/pwa` — the Home + global chat (Vite + React). Talks to the daemon only via
  `/api` and `/ws` (proxied in dev).
- `issues/` — canonical specs for v1 work, mirrored 1:1 to GitHub issues (file `001` = issue #1).

## Conventions that differ from defaults

- ESM only. TS strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax` (use `import type`). In-repo imports carry the `.ts`/`.tsx` extension.
- Prettier is enforced in CI (`format:check`): no semicolons, single quotes. Never hand-format.
- One file per module with its test alongside (`server.ts` / `server.test.ts`). No monolithic files.
- Test data with partial objects uses `fromPartial` from `@total-typescript/shoehorn`, not `as` casts.
- Work items reference their issue file in `issues/` and satisfy its acceptance criteria; say
  which criteria a PR satisfies.

## Where things are documented

- Architecture, key flows, anti-requirements: `ARCHITECTURE.md`
- Glossary — read before naming anything: `CONTEXT.md`
- Decisions and rationale: `docs/adr/` — check before proposing structural changes
- Security and trust model (trust levels, quarantined reader): `docs/SECURITY.md`
- Research behind the decisions: `docs/references/`
- Human contribution process: `CONTRIBUTING.md`
