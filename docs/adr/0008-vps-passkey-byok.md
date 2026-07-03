# VPS-first, passkey, BYOK; PWA as primary client, messengers as thin Bridges

v1 deployment profile: self-hosted daemon on a **VPS with a public IP** (the maintainer's real-world case with Hermes), automatic HTTPS/ACME, **passkey/WebAuthn** authentication with device pairing via QR — public endpoint + serious auth, no VPN required (SSH remains for administration only). **BYOK**: the user brings the API keys (Anthropic/OpenAI/OpenRouter), model routing is built on top. The PWA is the primary client; messengers (post-v1) are **Bridges**: quick input and notifications with deep links to the Home, short replies, never rich content — the Gateway is born with the `ChannelAdapter` interface so that Bridges are additive modules.

Status: accepted

## Considered Options
- Hosted multi-tenant: rejected for v1 — costs that scale, liability for the most intimate data, multi-tenancy to architect from day one. The door stays open to a managed hosted offering as a future business model (the Nous/Chronos path).
- Blind relay for home servers behind NAT: deferred to post-v1 (useless on a VPS; web push doesn't need it anyway).
- PWA-only without Bridges, forever: rejected — the value of messengers is not the UI but the zero friction of input/notification; giving that up forever sacrifices the growth funnel.
