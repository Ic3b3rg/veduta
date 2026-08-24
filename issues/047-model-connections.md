# 047 — Model connections: Claude and ChatGPT subscriptions in the PWA

## Context

The current onboarding presents API-key BYOK and model tiers as separate steps. A user who pays
for Claude or ChatGPT instead reaches a dead end: the runtime can already speak to relevant
provider APIs, but connecting the subscription requires undocumented terminal and vault
work, and the API-key validator rejects subscription credentials. That is not a supported user
journey.

[ADR-0014](../docs/adr/0014-subscription-inference-boundary.md) fixes the architectural
boundary: provider subscriptions supply inference behind `AgentRunner`; Veduta still owns the
single Agent loop, tools, trust decisions, Event log writes, and Surface changes. The design
also adopts the useful parts of
[OpenClaw's provider onboarding](https://docs.openclaw.ai/start/onboarding) and
[Hermes' provider setup](https://hermes-agent.nousresearch.com/docs/integrations/providers): a
provider-extensible connection registry, one consistent authorization lifecycle, and a live
test before saving.

## Goal

From the PWA, a user with a Claude or ChatGPT subscription can authorize an account, choose a
model from that account's catalog, verify a real inference call, and reach Home without using
the terminal or handling a raw token. Existing API-key users keep an equally supported path.

## What to build

- Replace the separate BYOK and Models onboarding steps with one **Model connection** step,
  reused by a global **Model connections** settings page after onboarding.
- Back the UI with a Gateway-owned, provider-extensible registry. Every adapter exposes the
  same capabilities and lifecycle states: available methods, authorizing, waiting for user,
  verifying, connected, expired, reconnecting, failed, and revoked. Provider-specific browser,
  device-code, and callback mechanics stay behind that contract.
- Ship these initial connection methods end to end:
  - Claude subscription through a Gateway-managed Claude Code/Agent SDK inference adapter with
    provider tools disabled. Authorization starts in the PWA; when a remote localhost callback
    cannot complete, the PWA accepts the authorization code itself rather than sending the user
    to a shell.
  - ChatGPT subscription through refreshable Codex OAuth, using browser/device authorization
    and automatic access-token refresh.
  - Existing Anthropic, OpenAI, and OpenRouter API-key connections through BYOK.
- Use only provider-supported subscription clients and authorization flows. Do not normalize the
  old `setup-token` vault workaround into product UX or impersonate a provider application when
  upstream support is unavailable; surface the adapter as unavailable with an exact reason
  instead.
- Store independently identified Model connection instances rather than one credential per
  provider. The data model supports multiple accounts for the same provider from day one;
  onboarding still needs only one working connection and does not expose pool ordering.
- Keep credentials and authorization codes inside the authenticated PWA-to-Gateway flow and the
  encrypted vault. Chat may inspect or change routing among already-authorized connections and
  deep-link to settings, but it may never add, reauthorize, revoke, or receive credentials.
- Fetch the model catalog for the selected connection. The visible routing control has exactly
  two selects: first the provider/account connection, then a model filtered to that connection.
  The first select uses labels such as `Claude · Subscription`, `OpenAI · ChatGPT subscription`,
  and `OpenRouter · API key`, collapsing to the provider name when only one account is present.
  Show the full returned catalog without a curated or recommended subset. Require the selected
  model to pass a real inference test; preserve the selection and show the provider's exact
  failure when it does not.
- Reuse the same two selects in onboarding and chat. They always show the active global
  connection and model; a successful change applies immediately to every Space and retains the
  conversation. A failed change rolls back visibly. Internal triage remains hidden.
- Require at least one verified real Model connection before Home on a real VPS profile. The
  Loopback profile keeps its automatic mock; Local VPS may use mock only through its explicit
  development control. After verification, onboarding offers Continue or Add another
  connection; it never presents a generic Skip. Never answer through mock after a real
  connection fails.
- Refresh subscription credentials automatically. Failover is allowed only to another
  connection the user explicitly authorized and enabled for fallback, and never silently from a
  subscription to metered BYOK. If nothing permitted is available, stop the turn with a visible
  reconnect action and record any connection change.
- Migrate existing BYOK routing and vault references into connection instances without asking
  the user to re-enter secrets or changing the active model.

## Acceptance criteria

- [ ] **Claude subscription:** on a real VPS, a user completes Claude authorization from the PWA
      (including the pasted-code fallback), selects a catalog model, passes a live inference
      test, finishes onboarding, and receives a streamed real response; no token or terminal
      step is exposed.
- [ ] **ChatGPT subscription:** the same journey succeeds with Codex device/browser
      authorization, and a forced access-token expiry refreshes without user intervention.
- [x] **Consistent UX:** Claude subscription, ChatGPT subscription, and all three BYOK methods
      render the same lifecycle and recovery states; provider-specific fields appear only when
      that adapter needs them.
- [x] **Routing controls:** onboarding and chat show one connection select plus one filtered model
      select, the full account catalog is available, successful changes apply globally and
      immediately, and failed changes roll back with the exact reason.
- [x] **Multiple accounts:** two independently named connections for one provider coexist and can
      be selected without overwriting each other's credentials; a migrated legacy BYOK install
      remains routed exactly as before.
- [x] **Failure policy:** a revoked subscription stops the turn with a reconnect action; a test
      proves there is no implicit metered or mock fallback, while an explicitly enabled safe
      fallback is surfaced and recorded.
- [x] **Security boundary:** provider-side tools cannot execute, credentials never enter chat,
      model context, logs, URLs, or process arguments, and connection mutations require an
      authenticated PWA session.
- [ ] Adapter contract tests cover authorization, refresh, catalog, verification, revocation,
      and error normalization with deterministic fakes; a documented manual smoke covers one
      real Claude account and one real ChatGPT account.

## Out of scope

- Subscription adapters for Gemini, Grok, OpenRouter, Trae, or other future providers.
- Per-Space credentials or routing overrides.
- User-visible credential-pool ordering, quotas, or load balancing.
- Delegating Agent turns or tools to the Claude Code or Codex applications.

## Blocked by

None — builds on completed issues [003](003-agent-runner-wrapper.md),
[010](010-model-routing.md), and [019](019-onboarding-wizard.md), and on
[ADR-0014](../docs/adr/0014-subscription-inference-boundary.md).

## Status note (2026-08-24)

[ADR-0016](../docs/adr/0016-primary-agent-connections-author-surfaces.md) and
[issue 070](070-codex-tool-parity.md) extend the shipped connection lifecycle with the complete
primary AgentRunner contract. Model connection onboarding, lifecycle, catalog, selection, refresh,
and failure behavior stay in this issue; provider-independent Agent routing belongs to issue 070.

Five of the eight criteria above are satisfied by what shipped (Consistent UX, Routing controls,
Multiple accounts, Failure policy, Security boundary). The deterministic coverage lives
alongside the implementation in `model-connection-*.test.ts`, `onboarding-*.test.ts`, and the PWA's
`model-connection-*.test.tsx` files. Three criteria stay open and cannot be closed by more code in
this repository alone:

- **Claude subscription** is unsatisfiable until Anthropic approves a third party offering
  Claude.ai login or routing subscription credentials — `claudeSubscriptionAdapter`
  (`packages/daemon/src/model-connection-claude.ts`) is permanently `unsupported` with that exact
  reason, by design (ADR-0014 amendment). See
  [`docs/references/11-model-connections-manual-smoke.md`](../docs/references/11-model-connections-manual-smoke.md)
  §"Claude subscription — the gate" for how to re-verify the gate has not silently lifted.
- **ChatGPT subscription** is implemented end to end behind the exactly-pinned `codex app-server`
  0.146.1 binary (device-code authorization, catalog, verify, streamed turns, automatic
  refresh, revoke) and every step is covered by contract and unit tests against
  `codex-app-server-fake.ts`. The real-account create-and-patch smoke passed on 2026-08-11 and is
  recorded in `docs/references/11-model-connections-manual-smoke.md`; forced provider-side token
  expiry remains reproducible only through deterministic fakes.
- **The adapter contract tests half of the last criterion is done** (`model-connection-adapter-contract.test.ts`,
  `describe.each` over BYOK, Claude and Codex); **the manual-smoke half is not** because of the
  provider-policy boundary above — a real Claude account smoke is impossible while the gate
  stands. Forced access-token expiry is exercised only through deterministic fakes
  (`model-connection-codex.test.ts`'s `refresh reports expired when the refresh call fails`),
  matching what `docs/references/11-model-connections-manual-smoke.md`
  records as the only testable path: the public ChatGPT API gives no way to force a provider-side
  token expiry on demand.
