# Reference 11 — Model connections: manual smoke and decision record

> Companion to [issue 047](../../issues/047-model-connections.md),
> [issue 073](../../issues/073-chatgpt-subscription-surface-authoring.md),
> [issue 077](../../issues/077-chatgpt-subscription-automations.md),
> [issue 078](../../issues/078-chatgpt-subscription-workers.md),
> [issue 079](../../issues/079-primary-connection-parity.md), the
> [ADR-0014 amendment](../adr/0014-subscription-inference-boundary.md), and
> [ADR-0016](../adr/0016-primary-agent-connections-author-surfaces.md). Automated tests cover
> every adapter against deterministic fakes; this documents the checks that need a real account
> or a human eye, and the wayfinder decision that unblocked the original connection work.

## ChatGPT subscription — real-account smoke

Prerequisites: a VPS or Local VPS install, a pinned `@openai/codex` 0.146.1 binary reachable at
`VEDUTA_CODEX_BIN` (or `<data root>/codex/bin/codex` -- provision it with
[`deploy/codex-setup.sh`](../../deploy/codex-setup.sh) rather than a hand-run `npm install`), a
ChatGPT account with device-code login enabled in its security settings.

1. Open Model connections (onboarding step or settings), add **OpenAI · ChatGPT subscription**,
   start authorization.
2. Confirm the PWA shows the verification URL and one-time code, with no token or terminal step.
3. Sign in on OpenAI's page, enter the code; the connection must reach `connected` with the plan
   type as its account label.
4. Confirm the model select lists the `model/list` catalog, select a model, verify — the live
   inference test must pass. Confirm this is the selected ChatGPT connection and no BYOK provider
   key is configured for the run.
5. Open a focused Space with no Agent-authored Surfaces and ask the Agent to create a small Surface
   with one bound state field. The offered `create_surface` definition must not contain `spaceId`,
   and the call must create the Surface in the focused Space without supplying one.
   The reply must stream into chat, the protocol-valid Surface must appear live without a page
   refresh, and no reduced-capability connection notice may be present.
6. In the same focused Space, ask the Agent to update that field. The turn must call
   `patch_state`; the rendered Atom must update live and the Surface must remain protocol-valid.
7. Focus Health and send exactly `aggiungi ai meals la fesa di tacchino`. Confirm the turn calls
   `list_surfaces`, then `read_surface` with the returned Meals id, then `patch_state` derived from
   the returned state. The PWA must prepend the local-time row, update the last-meal and count
   summary, and leave the Atom tree unchanged.
8. Send a natural paraphrase of the same request. Confirm the eligible real Model connection
   follows the same read-before-write path without an application or configuration change.
9. Return to global chat and ask it to change that Surface. It must not mutate the Surface: global
   chat still receives no Space tool registry. Inspect the focused Space's session, Surface
   provenance, and Event log and confirm they contain the same tool/result and
   `surface.create`/`surface.patch_state` records as a BYOK run, apart from provider metadata.
10. Trigger a refresh (`GET /api/model-connections/:id` after 5 idle minutes, or restart the
    daemon and reconnect) and confirm the connection stays `connected` without re-entering
    anything.
11. Disconnect. The UI must state that local credentials were cleared and provider-side sessions
    may need removal in the OpenAI account settings.

### Real-account execution record

- **2026-08-11 — passed:** Local VPS authorization store, pinned Codex 0.146.1,
  `gpt-5.6-luna`. The production Codex adapter, provider bridge, and `PiAgentRunner` ran against a
  temporary Veduta data root with empty `providerKeys`/`connectionKeys`; resolving an OpenAI API
  key returned `undefined`. The live account called exactly `create_surface` and then
  `patch_state` in 18.7 seconds. The final Surface parsed with state `status: "Patched"`, its
  provenance was `trusted:system`, the session contained both tool results, and the Space Event
  log contained `surface.create` followed by `surface.patch_state`. The existing Local VPS Spaces
  were not modified, and credential contents were not printed.

## Deterministic contract for Connection parity

The provider-parity suite drives the same public `AgentRunner.prompt()` scenarios through
BYOK/fake and Codex/fake. It compares the definitions observed at the BYOK boundary with the
actual Codex `dynamicTools` definitions, then compares accepted calls, handler results, final text,
normalized Agent events, session entries, and persistent outcomes while ignoring only
provider-assigned metadata:

- [`subscription-surface-flow.test.ts`](../../packages/daemon/src/subscription-surface-flow.test.ts)
  covers Surface creation and typed-state patching.
- [`provider-memory-parity.test.ts`](../../packages/daemon/src/provider-memory-parity.test.ts)
  covers FACTS, Event log reads, Retrieval, origins, and live taint.
- [`provider-template-parity.test.ts`](../../packages/daemon/src/provider-template-parity.test.ts)
  covers Template discovery, reuse, pinning, validation, and the direct-authoring justification
  gate.
- [`provider-automation-parity.test.ts`](../../packages/daemon/src/provider-automation-parity.test.ts)
  covers Space-bound listing, timers, recurring Automations, enabled state, cancellation,
  ownership, and handler-error replay safety.
- [`provider-worker-parity.test.ts`](../../packages/daemon/src/provider-worker-parity.test.ts)
  covers asynchronous spawn and delivery, isolated read-only tools, review call purpose, budget
  exhaustion, cancellation, and failure replay safety.
- [`provider-trust-parity.test.ts`](../../packages/daemon/src/provider-trust-parity.test.ts) covers
  allowlisted L1 execution, Untrusted-origin taint, Approval cards, and unconditional L2 carding.
- [`provider-tool-parity.test.ts`](../../packages/daemon/src/provider-tool-parity.test.ts) covers the
  generic definition/call/result loop, handler errors, and sequential accepted call ids.

The transport matrix remains separate in
[`codex-tool-turn.test.ts`](../../packages/daemon/src/codex-tool-turn.test.ts),
[`codex-app-server-protocol.test.ts`](../../packages/daemon/src/codex-app-server-protocol.test.ts),
and [`subscription-failover.test.ts`](../../packages/daemon/src/subscription-failover.test.ts):
malformed arguments, unknown tools, duplicate ids, correlation drift, abort, timeout,
version/capability drift, provider-native items, additive response fields, and post-effect retry
refusal all fail closed.

## ChatGPT subscription — Automation parity smoke

Use a disposable Space or disposable Automations so the checks do not disturb real reminders.
Complete the authorization and model-selection prerequisites above, select the ChatGPT
subscription connection, and leave every BYOK connection disabled for fallback during this run.

1. Open the disposable Space and locate its **Automations** Surface. Record the visible entries so
   later checks can distinguish pre-existing Automations from the ones created here.
2. In that focused Space, ask: `List every Automation in this Space.` Confirm the reply describes
   only the entries visible in that Space and exposes no internal Space id.
3. Ask: `Remind me in five minutes to check the Automation parity smoke.` Confirm one new enabled
   timer appears in the **Automations** Surface without refreshing the page.
4. Ask: `Create a daily Automation at 09:00 to review the Automation parity smoke.` Confirm a
   second enabled entry appears with a recurring schedule. Neither request should create a
   duplicate entry.
5. In a later chat turn, identify the daily Automation by its visible description and ask Veduta
   to disable it. Confirm its switch becomes off while the timer remains enabled.
6. Repeat the same disable request. Confirm the UI remains unchanged and no duplicate Automation
   or chat-side retry appears; setting the explicit enabled state is idempotent.
7. In another later turn, ask Veduta to cancel the timer by its visible description. Confirm only
   that timer disappears from the **Automations** Surface and the disabled daily entry remains.
8. Open a different Space, create one distinct recurring Automation there, then return to the
   original Space. Ask Veduta to list and disable every Automation **here**. Confirm the original
   Space changes while the other Space's Automation remains enabled and visible when reopened.
9. From the original Space, ask Veduta to change the Automation that belongs to the other Space.
   Confirm no Automation changes in either Space and the reply exposes neither an internal Space id
   nor whether a supplied numeric id exists elsewhere.
10. Return to **Model connections** and confirm the selected connection is still the ChatGPT
    subscription. No BYOK connection should have handled or replayed any of the turns.

The deterministic provider-parity test additionally compares normalized Agent events, session
entries, Scheduler records, visible Surface state, origins, Space Event records, handler call ids,
and failed dynamic-tool responses between BYOK/fake and Codex/fake. Run it with:

```sh
pnpm --filter @veduta/daemon exec vitest run src/provider-automation-parity.test.ts
```

## ChatGPT subscription — Worker parity smoke

Use a disposable Space because this check deliberately creates Worker report Surfaces and includes
a cancellation. Complete the authorization and model-selection prerequisites above, select the
ChatGPT subscription connection, and leave every BYOK connection disabled for fallback during this
run.

1. Open the disposable Space and add one distinctive fact to its recent chat context, such as
   `For this smoke check, remember that the recovery window is forty-eight hours.`
2. Send: `Start exactly one background Worker to inspect recent evidence in this Space and report
the recovery window. Let it use only read_recent, treat the briefing as high risk, and return
immediately instead of doing the investigation in this chat turn.`
3. Confirm the chat response finishes while one new **Worker:** Surface is still visible as
   **researching**, with progress and a **Cancel** button. A second Worker Surface must not appear.
4. Keep the Space open. Confirm that the same Surface updates without a page refresh to
   **Delivered**, contains the forty-eight-hour finding, and shows either **Review passed** or a
   visible review caveat. The chat transcript must not receive the Worker's evidence as a second
   synchronous answer.
5. Refresh the browser. Confirm the delivered Surface remains settled and no duplicate report or
   second delivery appears.
6. Start another deliberately slow Worker in the same Space with:
   `Start exactly one background Worker to inspect all recent evidence here. Use only read_recent
and return immediately; I will cancel it from the Surface.`
7. As soon as its active Surface appears, click **Cancel**. Confirm that Surface becomes
   **Cancelled**, carries the partial-result warning, and never later changes into a second clean
   delivery. The first delivered Worker Surface must stay unchanged.
8. Refresh once more. Confirm both terminal states persist and neither Worker has been duplicated.
9. Return to **Model connections** and confirm the selected connection is still the ChatGPT
   subscription. No BYOK connection should have handled or replayed either spawn.

The deterministic provider-parity test additionally proves the asynchronous identity/result
boundary, isolated `worker-*` session, read-only L0 definition set, protocol-valid Surface,
`untrusted:worker` provenance, usage attribution, fresh tool-less high-risk review, cancellation,
budget exhaustion, and post-tool failure without spawn replay. Run it with:

```sh
pnpm --filter @veduta/daemon exec vitest run src/provider-worker-parity.test.ts
```

## Claude subscription — the gate

Open Model connections and confirm **Claude · Subscription** renders as unavailable with the
exact reason (Anthropic requires prior approval for third-party Claude.ai login) and a
documentation link, and offers no login flow of any kind. The corresponding acceptance criterion
of issue 047 is unsatisfiable until Anthropic grants approval or publishes a public third-party
OAuth contract; this is a provider-policy boundary, not a missing feature.

## Wayfinder #53 decision and supersession

The original issue-047 decision established subscription adapters as inference-only engines behind
the Model connection contract: Veduta's Agent loop keeps tool execution, trust decisions, Event log
writes, and Surface changes; ChatGPT uses the pinned `codex app-server`; Claude subscription stays
unavailable until its provider permits third-party routing; and BYOK uses the same connection
lifecycle. ADR-0016 and issues 070–079 subsequently replaced the narrow initial Codex inference
boundary with the complete dynamic-tool contract while preserving every provider-native tool
refusal. Global chat scope remains a separate concern owned by issue 052.
