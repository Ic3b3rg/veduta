# VPS-first, passkey, BYOK; PWA as primary client, messengers as thin Bridges

v1 deployment profile: self-hosted daemon on a **VPS with a public IP** (the maintainer's real-world case with Hermes), automatic HTTPS/ACME, **passkey/WebAuthn** authentication with device pairing via QR — public endpoint + serious auth, no VPN required (SSH remains for administration only). **BYOK**: the user brings the API keys (Anthropic/OpenAI/OpenRouter), model routing is built on top. The PWA is the primary client; messengers (post-v1) are **Bridges**: quick input and notifications with deep links to the Home, short replies, never rich content — the Gateway is born with the `ChannelAdapter` interface so that Bridges are additive modules.

Status: accepted

## Amendments

- [ADR-0014](0014-subscription-inference-boundary.md) replaces BYOK as the only real-model setup path with Model connections: subscription-backed and BYOK connections share one Gateway-owned boundary.
- [ADR-0015](0015-vps-access-modes.md) separates the VPS profile from browser exposure. A VPS may use Public, Tunnel, or Tailnet access; a public domain is no longer an invariant of the profile.
- [ADR-0028](0028-concrete-bridge-extension-seam.md) replaces the requirement that the Gateway be born with a generic `ChannelAdapter` and narrows the permanent exclusion of rich Bridge content: the Gateway owns the PWA transport directly, and the first concrete messenger Bridge defines the extension seam for later Bridges. Short text and Home deep links remain the committed baseline; provider-native rich projections stay prohibited under the current architecture but may be reconsidered through separate research and an accepted ADR.

## Considered Options

- Hosted multi-tenant: rejected for v1 — costs that scale, liability for the most intimate data, multi-tenancy to architect from day one. The door stays open to a managed hosted offering as a future business model (the Nous/Chronos path).
- Blind relay for home servers behind NAT: deferred to post-v1 (useless on a VPS; web push doesn't need it anyway).
- PWA-only without Bridges, forever: rejected — the value of messengers is not the UI but the zero friction of input/notification; giving that up forever sacrifices the growth funnel.
