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
