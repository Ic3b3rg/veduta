# AGENTS.md

Veduta is an open source, self-hosted, home-first personal agent: persistent Surfaces per life
area in a PWA, maintained by a single agent loop. pnpm TypeScript monorepo. This file is the
single source of truth for coding agents; `CLAUDE.md` just imports it.

## Commands

- Install: `pnpm install` — pnpm only, never npm or yarn
- Dev: `pnpm dev` → daemon on `http://127.0.0.1:8787` + PWA on `http://localhost:5173` (mock
  LLM provider and seed data — no VPS, domain, or API key required, by design)
- Test package unit/integration suites: `pnpm test` · one package:
  `pnpm --filter @veduta/daemon test` · one file:
  `pnpm --filter @veduta/daemon exec vitest run src/server.test.ts` — use `exec vitest run`, not
  `test -- <file>`: pnpm forwards the `--` to vitest, which then ignores the path and silently runs
  the whole suite instead of the file you asked for
- Before finishing any change, run `pnpm check` (lint, formatting, typecheck, package tests, build).
  Browser E2E is a separate CI job and is not included in `pnpm test`.

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
- **A comment may only cite something a reader of this repository can open.** Working notes
  (`tasks/`) are never committed, so a comment citing `tasks/plan.md`, a numbered "decision 7",
  or a review-round label (`A3`, `B12`, `D10`, `T5`, "this fix group's report") points at
  nothing. Put durable rationale in an ADR, the `issues/NNN-*.md` spec, `docs/references/`, or
  the comment itself — then cite that. Enforced by `dead-references.test.ts`.

## Execution guardrails

- Before proposing or implementing a change, read the relevant issue and comments, its matching
  specification under `issues/`, related issues, `CONTEXT.md`, `ARCHITECTURE.md`, and applicable
  ADRs. Check for an existing general solution before proposing a duplicate vertical fix.
- If the intended product behavior or acceptance criteria are materially ambiguous, or canonical
  sources conflict, stop and ask for clarification before coding.
- Automated checks are necessary but not sufficient for behavior changes. Verify the exact
  user-visible scenario at runtime with clean test data, including refresh or reconnect behavior
  and relevant error paths when applicable.
- Manual QA instructions must exercise the changed behavior end to end. For user-facing changes,
  default to UI instructions; include terminal or API steps only when explicitly requested.
- Before claiming completion, confirm that checks passed, runtime behavior was verified, persistent
  test artifacts were removed, and the worktree, remote, and issue tracker states are accurately
  reported. Never imply that a commit was pushed or an issue closed without verifying it.
- Keep communication proportional: explain the task context before implementation details, avoid
  redundant confirmations, and stop asking questions once the required decisions are settled.

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

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues and mirrored by canonical specifications under `issues/`. See
`docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the five default triage roles. See `docs/agents/triage-labels.md`.

### Domain docs

The repository uses a single-context domain layout. See `docs/agents/domain.md`.
