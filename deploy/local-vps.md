# Local VPS profile

An operator guide for running Veduta's **Local VPS profile** -- a local execution profile that
exercises the same core production flows as a real VPS deployment (real passkey/WebAuthn auth,
BYOK or mock LLM routing, persistent configuration, egress enforcement, the full onboarding
wizard) on your own machine, with explicit local substitutes for VPS-only infrastructure. The
decision and its rationale are in [docs/adr/0009-local-vps-profile.md](../docs/adr/0009-local-vps-profile.md);
the acceptance criteria this profile satisfies are in
[issues/023-local-vps-profile.md](../issues/023-local-vps-profile.md).

## What this is NOT

This is **not** `pnpm dev`. `pnpm dev` stays the lightweight **loopback profile** (ADR-0009):
no auth (a dev token stands in for a session), a mock provider, and no onboarding wizard --
built for fast iteration on the daemon and PWA themselves. The Local VPS profile is slower to
boot (it builds the PWA and runs a real passkey ceremony) and exists for a different purpose:
rehearsing the actual user journey -- including its trust and security posture -- before
touching a real VPS.

## How to run

```sh
pnpm local-vps
```

### Flags

| Flag                | Default               | Meaning                                    |
| ------------------- | --------------------- | ------------------------------------------ |
| `--port <n>`        | `8788`                | Port the daemon listens on                 |
| `--base-dir <path>` | `~/.veduta-local-vps` | Base directory for `data/` and `vault.key` |
| `--help`            | --                    | Print usage and exit                       |

The command builds the PWA, then supervises the daemon under `VEDUTA_PROFILE=local-vps`,
restarting it whenever it exits `0` (the onboarding wizard's finish step does this on purpose so
newly-applied configuration takes effect). A nonzero exit stops the loop and is propagated as
the runner's own exit code. Ctrl-C (SIGINT) or SIGTERM stops the daemon and the runner cleanly.

### First boot journey

1. Run `pnpm local-vps`. It prints a setup URL to stderr once the daemon is ready, e.g.
   `http://localhost:8788/setup?code=...`.
2. Open that URL **in a browser** -- see the caveat below about `localhost` vs `127.0.0.1`.
3. Register a passkey (WebAuthn). This is a real ceremony: your browser/OS/security key handles
   it exactly as it would against a real VPS.
4. Walk the onboarding wizard: domain (read-only -- there is no public domain here), BYOK (skip
   to keep the mock provider, or add a real key), models, first Space, integrations.
5. Finish. The wizard's finish step makes the daemon exit `0` on purpose; the runner loop
   restarts it with the new configuration, and the wizard itself waits for the daemon to answer
   again before showing Home.
6. Land on Home.

### Where state lives

Everything is under the base directory (`~/.veduta-local-vps` by default, or `--base-dir`):

- `data/` -- `VEDUTA_DATA_DIR`: Spaces, stores, sessions, the encrypted secrets vault, and
  `routing.json`/`ingestion.json`. Created `0700`.
- `vault.key` -- `VEDUTA_VAULT_KEYFILE`: the secrets vault keyfile, generated once on first boot
  if absent. Lives outside `data/` (mode `0400`), the same separation of concerns as the real
  VPS profile's `/etc/veduta/vault.key` living outside `/var/lib/veduta/.veduta`.

### How to reset

The runner **never deletes anything** -- no `--fresh` flag, no automatic cleanup. To start over,
delete the base directory yourself:

```sh
rm -rf ~/.veduta-local-vps   # or your --base-dir
```

## Substitution table

| Concern                                  | VPS profile                  | Local VPS profile                                            |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------ |
| Auth ceremonies, sessions, lockout       | identical                    | identical                                                    |
| Onboarding wizard                        | identical                    | identical                                                    |
| Egress enforcement                       | identical                    | identical                                                    |
| Routing (`routing.json`) + secrets vault | identical                    | identical                                                    |
| TLS / certificates                       | ACME-issued (Let's Encrypt)  | none -- the browser's `localhost` secure context substitutes |
| Public domain                            | `VEDUTA_PUBLIC_DOMAIN`       | none -- `http://localhost:<port>`                            |
| Process supervision                      | `systemd` (`Restart=always`) | `deploy/local-vps.sh`'s restart-on-exit-0 loop               |
| Agent loop                               | identical                    | identical                                                    |

The last row used to be the odd one out: before the real Agent loop wiring (issue #37) landed,
Local VPS ran a deterministic chat->Surface demo that the VPS profile did not. That is gone --
every profile now routes every chat turn through `ModelRouter.execute`, landing on a real
provider wherever BYOK resolves a key and on the same deterministic mock candidate everywhere
else (loopback, Local VPS, and a keyless VPS alike).

## The `localhost` caveat

Open **`http://localhost:<port>`**, not `http://127.0.0.1:<port>`. The daemon registers its
WebAuthn relying party with `rpID: 'localhost'`; `127.0.0.1` is a different WebAuthn origin and
the browser will refuse to match your registered passkey against it.

## Switching the provider: mock to real

No flow change -- this is configuration only, the same shape as the VPS profile. **Prefer the
wizard**: during onboarding, use the BYOK step (in the browser) to add a provider key instead of
skipping it -- the key never touches argv or shell history.

Only if you need to set a key outside the wizard, the vault CLI works against the same data
directory:

```sh
VEDUTA_VAULT_KEYFILE=~/.veduta-local-vps/vault.key \
  pnpm --filter @veduta/daemon vault set anthropic sk-ant-... --root ~/.veduta-local-vps/data
```

**Caution:** this form puts the raw provider key in argv, which most shells record in history and
which is visible to other processes on the machine (e.g. `ps`) while the command runs. Use it only
when the wizard path is not an option.

Either path points `routing.json`'s `providerKeys[name]` at `secret://vault/<name>`. With no key
configured for a tier, the router falls back to the keyless mock candidates (`withMockFallback`
in `packages/daemon/src/model-routing.ts`) so triage/reasoning stay routable regardless.

### BYOK smoke check (issue #37 AC7)

The manual acceptance check for the real Agent loop — deliberately not CI-gated because it
spends real provider credit:

1. Boot the profile and add a real provider key through the wizard's BYOK step (or the vault
   CLI above), so `routing.json`'s reasoning tier resolves that provider.
2. Open a Space and send any chat message from the browser.
3. Expect: a streamed reply renders token by token (the in-progress entry with the pulsing
   cursor), the final text lands in the chat log, the Space's Event log
   (`GET /api/spaces/<id>/events`) shows the `type: 'turn'` user and assistant entries, and
   `data/usage/<today>.jsonl` records the spend against the reasoning tier.
4. Remove the key (or switch back to mock) and confirm the same flow still answers
   deterministically — that is the mock candidate, not a parallel code path.

Record the outcome (date, provider, model) in the issue or deployment notes when performed.

## Living scope

[`packages/e2e/tests/local-vps.spec.ts`](../packages/e2e/tests/local-vps.spec.ts) (run via
`pnpm --filter @veduta/e2e run test:e2e`) is a real-browser, real-WebAuthn end-to-end journey
against this exact profile, and doubles as the checklist of core flows this profile currently
covers: first boot, passkey registration, the onboarding wizard, chat->Surface (the mock chat
demo), the fast path, restart persistence, and re-login. The scope is living, per ADR-0009 --
as new core product flows are added, extend that spec rather than starting a second one.
