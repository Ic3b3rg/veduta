# Local VPS profile for production-like development

Veduta keeps a `Local VPS profile` alongside `pnpm dev`: a local execution profile that aims for user-visible flow parity with the VPS profile, while allowing local orchestration such as Docker Compose and explicit substitutes for VPS-only infrastructure. This lets us test core production flows locally, including passkey login, BYOK or mock LLM routing, persistent config, Home, chat, Surfaces, and restarts, without freezing development on a real public deployment.

Status: accepted

## Consequences

- `pnpm dev` remains the lightweight loopback profile with dev token and mock provider.
- The `Local VPS profile` becomes the place to rehearse core production flows before touching a real VPS.
- VPS-only concerns like ACME, public domain, and systemd can be simulated locally as long as the user-visible flow stays equivalent.
- Future core features can be added to the profile over time, so the checklist remains living instead of fixed.
