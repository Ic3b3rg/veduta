# PRD — Veduta

## 1. Problem

The SOTA personal agents (OpenClaw, Hermes) live inside third-party chats (Telegram/WhatsApp). The pain, verified first-hand by the maintainer as a user of both:
- Confined to a chat, with the UI limited to the messenger's formatting
- No "clear view at first glance": you open it and see the last conversation, not the state of your life
- No interface personalization
- Wall-of-text answers for inherently structured content (plans, trackers, lists)

Antirez: *"the agents you talk to via Telegram or WhatsApp […] are not well made; there's room"* — and human-AI interfaces need rethinking: today "you see nothing".

## 2. Thesis and differentiators

**Thesis**: a personal agent with a real home beats a personal agent inside a chat.

| Differentiator | Against whom |
|---|---|
| Home-first: persistent Surfaces per life area, proactively updated | OpenClaw/Hermes (chat-first even with the Canvas), Gemini Dynamic View (ephemeral per-prompt UIs) |
| Cross-platform via PWA (iOS+Android+desktop), not locked into WidgetKit | Skye (iPhone-only, read-only Apple widgets) |
| Open source, self-hosted, BYOK, data in your own home | Skye, Alexa+ (proprietary cloud, dedicated hardware) |
| Deterministic fast path: instant interactions like a real app | All chat-first products (every interaction = an LLM wait) |
| Transparency: visible/editable memory, visible/switch-off-able Automations | Everyone ("the plus of having a UI") |

## 3. Target user (v1)

A developer/power user who already self-hosts (or can spin up a VPS), today a dissatisfied user of OpenClaw/Hermes. Arrives via the importer with their memory and configuration. The maintainer is user zero.

## 4. v1 scope

### In
- Complete daemon skeleton: agent loop (single, triage/reasoning routing, BYOK), Spaces (3-layer memory + validated writes), surface engine (tree+state+bindings, fast/agent path), scheduler (one-shot timers, jobs, safety-net Heartbeat), event ingestion (webhooks, Gmail/Calendar, pre-filters, quarantined reader)
- **A generic system from day one**: no privileged domain. The Home shows all Spaces; each user uses them as they wish (diet, work, gym, all together)
- Atom catalog: ChatKit set (~24) + `Progress`, `Stat`, `ListItem`, `Automation`; emergent Templates
- PWA: Home, global chat (which focuses when opening a Space), approval cards, web push, passkeys
- Onboarding wizard in the PWA (stage protocol) + importers from OpenClaw and Hermes
- Complete trust layer (L0/L1/L2, untrusted content, egress allowlist, vault, audit)

### Out (painfully, but out)
- Telegram/WhatsApp Bridges (immediately after: the Gateway is born adapter-ready)
- Home-server profile (blind relay / documented Tailscale)
- Sandboxed HTML escape hatch for custom Surfaces
- Marketplace/registry of community Templates and skills
- Multi-user on the same daemon; voice

## 5. Success criteria

1. **Dogfooding**: the maintainer stops using Hermes within 30 days of daily use. If the product doesn't convince even him to migrate, no additional feature saves the launch.
2. The Home answers the question "what do I need to know right now?" without the user asking anything (fresh Surfaces: never stale state presented as current).
3. Fast path interactions < 100ms perceived; synchronous chat response with no agent hierarchies in the path.
4. An OpenClaw/Hermes user completes import + first Space in < 15 minutes.
5. Operating cost of proactivity: ≥ 90% reduction in LLM calls versus the 30-minute polling baseline (measured).

## 6. Main risks

| Risk | Mitigation |
|---|---|
| Skye launches first with a similar concept | Speed on what they cannot do: open source, cross-platform, owned Surfaces (not WidgetKit) |
| pi-agent-core 0.x unstable / bus factor | Total wrapping (`AgentRunner` etc.), pinning, plan B AI SDK v6 (~1 week of migration) |
| Stale Surfaces → distrust | Visible freshness metadata + one-shot timers + success criterion no. 2 |
| Prompt injection via external events | Quarantined reader + taint gating + egress allowlist ([SECURITY.md](docs/SECURITY.md)) |
| Premature horizontality (solo-dev project) | Rigid v1 scope; issues with acceptance criteria; explicit anti-requirements |
| iOS: PWA installation funnel | Guided installation onboarding; messenger Bridges as a post-v1 funnel |

## 7. Post-v1 roadmap (directional)

1. Telegram Bridge (growth funnel), then WhatsApp
2. Home-server profile with E2E blind relay
3. Community Template registry; sandboxed escape hatch
4. Optional managed hosting as a business model (the Nous/Chronos path), without touching the open core
