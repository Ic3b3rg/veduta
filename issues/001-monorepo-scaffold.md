# 001 — Monorepo scaffold

## Goal
A pnpm TypeScript monorepo with the base packages and shared toolchain.

## Tasks
- pnpm workspace: `packages/daemon` (Node), `packages/pwa` (Vite + PWA), `packages/protocol` (shared schemas, zero runtime dependencies), `packages/catalog` (Atom renderer)
- TypeScript strict, ESLint, Prettier, Vitest; GitHub Actions CI (lint, typecheck, test)
- Conventions: one file per module/step with its test alongside (OpenClaw-style structure, not Hermes-style monolithic files — see [ref. 04](../docs/references/04-onboarding-migration.md))
- MIT license; keep CONTRIBUTING.md in sync with the actual dev experience
- **Dev profile** (`pnpm dev`): daemon on loopback with plain HTTP and a dev token instead of passkeys (production hardening from issue 005 must never be a prerequisite for local development); PWA dev server with hot reload proxied to the daemon
- **Mock LLM provider**: a deterministic in-repo provider so development and tests require no API keys; real providers opt-in via env
- **Seed data**: `pnpm dev` boots with an example Space and a couple of Surfaces so the Home is never empty on first run

## Acceptance criteria
- `pnpm install && pnpm build && pnpm test` green on a freshly cloned repo
- A type declared in `protocol` is importable from `daemon` and `pwa` without manual build steps
- On a clean machine with no domain, VPS, or API key: `pnpm install && pnpm dev` → open `http://localhost:<port>` → the Home renders with seed data and the mock provider answers in chat

## Notes
In tests with partial data use `@total-typescript/shoehorn` (the `migrate-to-shoehorn` skill is available) instead of `as`.
