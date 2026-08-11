# Reference 11 — Model connections: manual smoke and decision record

> Companion to [issue 047](../../issues/047-model-connections.md),
> [issue 073](../../issues/073-chatgpt-subscription-surface-authoring.md), the
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
   refresh, and the obsolete no-tools compatibility note must not be present.
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

That quote is the historical issue-047 decision. ADR-0016 supersedes only its Codex exception:
issue 073 enables the hardened dynamic-tool path for focused-Space turns while keeping
provider-native tools disabled and global chat without tools.
