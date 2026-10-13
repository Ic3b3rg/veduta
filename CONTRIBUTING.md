# Contributing to Veduta

Start with the [README](README.md) and [glossary](GLOSSARY.md). Consult the
[architecture](ARCHITECTURE.md), [product scope](PRD.md) and relevant [ADRs](docs/adr/)
for the part you are changing. [GitHub Issues](https://github.com/Ic3b3rg/veduta/issues)
hold work specifications and acceptance criteria; coordinate on an existing issue before
starting overlapping work. Architectural proposals explain the trade-off in an ADR.

## Development

```sh
git clone https://github.com/Ic3b3rg/veduta && cd veduta
pnpm install
pnpm dev
```

Use the Node and pnpm versions declared in `.node-version` and `package.json`.
Development runs on loopback with a mock provider and example data; no production credentials
or VPS are needed. For production-like authentication and onboarding, use [Local VPS](deploy/local-vps.md).

## Tests and CI

Use Vitest directly for a focused test; the `--` separator in `test -- <file>` can leave
the file filter unread and run the whole package suite instead:

```sh
pnpm --filter @veduta/daemon exec vitest run src/server.test.ts
pnpm --filter @veduta/daemon exec vitest run src/server.test.ts -t 'keeps the exact calorie answer'
pnpm --filter @veduta/pwa exec vitest run src/pending-decision-state.test.ts
pnpm --filter @veduta/e2e exec playwright test tests/chat-usability.spec.ts
```

`pnpm test` runs independent packages without dependency-order barriers, with at most two
packages at a time. CI also caps Vitest at two isolated workers per package. Individual test
deadlines, process isolation and stateful browser journey ordering stay intact.

Playwright builds the PWA once before its two workers start. Every Local VPS journey and
restart, signed update fixture and product reference preview reads that build. For a slower
machine, pass `--workers=1`. After building the current checkout explicitly, set
`VEDUTA_E2E_PREBUILT_PWA=1` to reuse those assets; a missing index fails before tests start.

CI runs the package tests alongside lint, formatting and `pnpm build`. The build typechecks
every package once, then bundles the PWA and website. Packages that produce artifacts expose
a `bundle` script; each package's `build` also typechecks. Browser tests download that exact
run's assets and exercise the authenticated journeys and public demo. The existing `checks`
status succeeds only when all three jobs succeed; failed, cancelled or skipped jobs block it.
Superseded PR runs are cancelled, and browser failures retain their traces as a CI artifact.

## Before submitting

- Follow the shared [project rules](AGENTS.md): vocabulary, architecture boundaries, English
  repository content, code conventions and verification. Keep one issue per focused PR and
  state which acceptance criteria it satisfies.
- Run `pnpm check`. Behavior changes also need runtime evidence for the requested scenario and
  relevant error/reconnect paths; document any remaining limitation.
- UI changes follow the [visual-language contract](docs/VISUAL-LANGUAGE.md). Use the real shared
  components and inspect `/showcase/reference` at phone and desktop widths, including long,
  failure and reduced-motion states. Agree substantial interaction changes through a prototype.

## License

MIT. Contributions are licensed under the project's [LICENSE](LICENSE).
