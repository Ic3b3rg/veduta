# Reference 11 — Model connections: manual smoke and decision record

> Companion to [issue 047](../../issues/047-model-connections.md) and the
> [ADR-0014 amendment](../adr/0014-subscription-inference-boundary.md). Automated tests cover
> every adapter against deterministic fakes; this documents the two checks that need a real
> account or a human eye, and the wayfinder decision that unblocked the work.

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
   inference test must pass.
5. Send a chat message; the reply must stream token-by-token, and the connection's "answers in
   text only" note must be visible.
6. Trigger a refresh (`GET /api/model-connections/:id` after 5 idle minutes, or restart the
   daemon and reconnect) and confirm the connection stays `connected` without re-entering
   anything.
7. Disconnect. The UI must state that local credentials were cleared and provider-side sessions
   may need removal in the OpenAI account settings.

## Claude subscription — the gate

Open Model connections and confirm **Claude · Subscription** renders as unavailable with the
exact reason (Anthropic requires prior approval for third-party Claude.ai login) and a
documentation link, and offers no login flow of any kind. The corresponding acceptance criterion
of issue 047 is unsatisfiable until Anthropic grants approval or publishes a public third-party
OAuth contract; this is a provider-policy boundary, not a missing feature.

## Wayfinder #53 decision comment

The decision posted to the wayfinder frontier ticket:

> Decision: narrow boundary redraw. Subscription adapters wrap first-party provider runtimes as
> inference-only engines behind the Model connection contract; Veduta's Agent loop keeps tools,
> trust decisions, Event log writes and Surface changes for every connection method. ChatGPT
> ships real, through a pinned `codex app-server` child process (device-code login, catalog via
> `model/list`, one tool-less thread per turn, fail-closed when the app-server does not confirm
> an empty tool set). Claude subscription ships as a permanently gated adapter, unavailable with
> the exact approval-requirement reason, per the issue-51 research. BYOK becomes one Model
> connection method behind the same contract. Recorded in the ADR-0014 amendment.
