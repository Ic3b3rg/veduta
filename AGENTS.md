# AGENTS.md

Veduta is a self-hosted personal agent with persistent Surfaces per Space, built as a pnpm
TypeScript monorepo. These are the shared project instructions; `CLAUDE.md` only imports them.

## Working contract

- Carry forward the user's scope, decisions and authorization across turns. Ask only for an
  unresolved material product decision, conflicting requirement, or human-only action; continue
  independent work while waiting. An already answered question is not a new gate.
- Before implementation, read the relevant issue and comments, [GLOSSARY.md](GLOSSARY.md), and
  applicable architecture/ADRs. Check existing shared flows before adding another implementation.
  The latest explicit user decision resolves task scope; record a changed durable contract in
  its canonical issue or ADR. Research and old drafts are evidence, not additional requirements.
- Preserve unrelated local changes. Work from a verified base and distinguish local, remote,
  released and deployed code. Follow [the workflow](docs/agents/workflow.md) for UI proposals,
  external access, resumptions, PR integration and worktree cleanup.
- Verify changed behavior at runtime with clean data, including refresh/reconnect and relevant
  failure paths. For UI changes, use the available shared browser and provide UI-first QA steps.
  Run `pnpm check` before finishing a repository change; report any unverified scenario explicitly.
- Completion reports name what shipped, what remains, the checks run and the verified PR/issue
  state. A passing branch is not a merged PR, a published release is not a deployment, and a
  cancelled issue is not an implemented fix.

## Commands

- `pnpm install`; use pnpm throughout.
- `pnpm dev`: Gateway `http://127.0.0.1:8787`, PWA `http://localhost:5173`, mock provider and
  example data. Local development needs no VPS, domain or API key.
- `pnpm --filter @veduta/daemon exec vitest run src/server.test.ts` runs one test file.
  `test -- <file>` silently runs the full suite because of argument forwarding; use `exec`.
- `pnpm check`: lint, formatting, typecheck, package tests and build. Browser E2E is an
  additional CI step, excluded from `pnpm test`.

## Architecture and data boundaries

- Use the exact glossary terms, avoiding its listed alternatives. Respect
  [ARCHITECTURE.md §7](ARCHITECTURE.md#7-what-we-do-not-build-anti-requirements): no persistent agent hierarchies,
  generated HTML in Surfaces, knowledge graphs or provider-native rich messenger projections.
  A different Bridge projection requires research and an accepted ADR.
- Never import `pi-agent-core` outside the AgentRunner wrapper (ADR-0004). Use our interfaces:
  `AgentRunner`, `ModelRef`, `ToolDef`, `SessionStore`.
- Every committed fast-path mutation records its Space Event (ADR-0003/ADR-0030).
  Preserve the shared validation, persistence and recovery boundaries.
- Validate Surfaces with `@veduta/protocol` before persistence or rendering. Unknown Atom types
  render visibly through `UnknownAtom` rather than crashing or disappearing.

## Code and documentation

- English in code, comments, commits, issues and docs. No AI-signature commit trailers.
- ESM, strict TypeScript and explicit `.ts`/`.tsx` imports; use `import type` for types.
  Let Prettier format changes. Keep focused modules with adjacent tests.
- Partial test objects use `fromPartial` from `@total-typescript/shoehorn`, not `as` casts.
- Generate lockfile changes through pnpm; keep build output, coverage and working notes out of git.
- Comments cite durable repository files or public issues. Put rationale in an ADR, reference
  document or the comment itself; private `tasks/` notes and review-round labels are not sources.
- Keep each rule authoritative in one place. Before deleting a document, check inbound references;
  retain evidence cited by current decisions. Remove uncited obsolete notes rather than maintaining
  another guide. All packages share the root glossary and `docs/adr/`; update their references
  together, read amendments before declaring conflicts, and repair renamed or missing links.

## Read when relevant

| Work                                      | Source                                                            |
| ----------------------------------------- | ----------------------------------------------------------------- |
| Product and system design                 | [PRD](PRD.md), [Architecture](ARCHITECTURE.md), [ADRs](docs/adr/) |
| Authentication, trust or external effects | [Security](docs/SECURITY.md)                                      |
| UI composition and shared controls        | [Visual language](docs/VISUAL-LANGUAGE.md)                        |
| Issue/PR lifecycle and labels             | [Issue tracker](docs/agents/issue-tracker.md)                     |
| Installation or access repair             | [Deployment](deploy/README.md)                                    |
| Signing, publishing or offering an update | [Release runbook](RELEASING.md)                                   |
| Human contribution setup                  | [Contributing](CONTRIBUTING.md)                                   |

The package boundaries are protocol (schemas), daemon (Gateway and persistence), catalog
(React Atom renderers) and PWA (client). The PWA uses `/api` and `/ws`; catalog imports no daemon code.
