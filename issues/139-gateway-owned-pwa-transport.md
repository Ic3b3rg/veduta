# Let the Gateway own the PWA transport directly

## What to build

Implement [ADR-0028](https://github.com/Ic3b3rg/veduta/blob/main/docs/adr/0028-concrete-bridge-extension-seam.md) by removing the speculative common channel transport layer and letting the Gateway own the PWA transport directly. The Gateway should keep one PWA connection and session registry, route validated PWA frames itself, and send targeted replies and broadcasts without an intermediate adapter.

Remove normalization, identity, contract-test, and short-reply scaffolding that exists only for a future messenger Bridge. Preserve the complete daemon-to-PWA protocol and every existing chat, Surface, presence, multi-device, and reconnect behavior. Do not add Slack or another Bridge, and do not pre-design the future Bridge extension API: the first concrete Bridge project will derive that seam from its real provider requirements under ADR-0028.

Closed issue #4 remains the historical record of the original adapter-ready implementation. Do not rewrite it or reintroduce its superseded architecture.

## Acceptance criteria

- [ ] The Gateway owns one PWA connection registry and directly handles validated inbound chat frames, targeted replies, and broadcasts; client identity and optional Space scope are preserved.
- [ ] No generic channel adapter implementation, duplicated adapter connection registry, fake adapter contract, adapter-only identity plumbing, or unused Bridge short-reply helper remains.
- [ ] The daemon-to-PWA wire protocol is unchanged, including schema validation and visible error behavior.
- [ ] Gateway-level tests preserve Surface-event fan-out, chat replies, approvals, Pending-decision lifecycle, Space attention, presence, session revocation, full-text replies, multi-device behavior, and reconnect replay.
- [ ] With clean Loopback-profile data, two browser sessions still receive the same committed Surface change, and a disconnected session converges after reconnect without a full reload.
- [ ] No messenger Bridge, provider-native rich projection, or speculative replacement interface is introduced; current architecture documentation remains aligned with ADR-0028.
- [ ] `pnpm check` passes.

## Blocked by

None - can start immediately
