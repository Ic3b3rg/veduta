# 001 — Monorepo scaffold

## Goal
A pnpm TypeScript monorepo with the base packages and shared toolchain.

## Tasks
- pnpm workspace: `packages/daemon` (Node), `packages/pwa` (Vite + PWA), `packages/protocol` (shared schemas, zero runtime dependencies), `packages/catalog` (Atom renderer)
- TypeScript strict, ESLint, Prettier, Vitest; GitHub Actions CI (lint, typecheck, test)
- Conventions: one file per module/step with its test alongside (OpenClaw-style structure, not Hermes-style monolithic files — see [ref. 04](../docs/references/04-onboarding-migration.md))
- MIT license, minimal CONTRIBUTING.md

## Acceptance criteria
- `pnpm install && pnpm build && pnpm test` green on a freshly cloned repo
- A type declared in `protocol` is importable from `daemon` and `pwa` without manual build steps

## Notes
In tests with partial data use `@total-typescript/shoehorn` (the `migrate-to-shoehorn` skill is available) instead of `as`.
