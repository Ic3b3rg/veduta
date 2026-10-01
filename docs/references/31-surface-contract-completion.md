# Surface contract completion — 2026-10-01

This records the final acceptance audit for
[issue #140](https://github.com/Ic3b3rg/veduta/issues/140) and its semantic boundary in
[issue #150](https://github.com/Ic3b3rg/veduta/issues/150). The
[machine-readable real-run record](surface-smoke-2026-10-01.json) contains disposable records,
canonical commit/intent identities, the shared Chart/history binding, and measured browser layout.
It contains no account credentials, real health data, or private provider transcript.

## Actual ChatGPT run

The real Local VPS profile used the selected **OpenAI ChatGPT subscription**, `gpt-5.6-luna`, and
pinned Codex **0.146.1**. The real connection remained `connected` after restart. The public Model
connections snapshot contained that single connection and `mockEnabled: false`; no BYOK connection
or mock fallback handled these turns. The existing authorized connection was copied into a new,
private disposable profile. The user's existing Local VPS root and credentials were left intact.

Home Chat created **Surface smoke** through its Pending decision. At the start of the accepted run
this Space had no Agent-authored Surfaces. All business input, notes, diet and measurements were
invented test data. Two disposable authenticated device/session identities on separate
`localhost` and `127.0.0.1` browser origins both passed public authentication and displayed the
same complete results. Physical passkey enrollment is covered separately by the clean Local VPS
E2E suite.

| Scenario             | Real request and observed result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editable Form        | Requested an Add item Surface with Item Input, Notes Textarea, and one submit-only Add Form. A follow-up requested the saved Item/Notes display. Typing left canonical drafts empty, the collection unchanged, and the Space Event count unchanged. Enter added `Surface smoke item` with `Disposable notes 140`; the button added `Second smoke item` with `Button submission`. Both fields cleared after each submit. The public Event log contains exactly two correlated `fast_path` commits and the state contains two distinct stable record ids. Both records remained after reload.                              |
| Three-day plan       | Sent exactly `data la mia dieta fammi una scheda per la palestra 3 giorni a settimana`. With no diet yet recorded, ChatGPT asked for context. Supplied an explicitly fictitious adult beginner profile, complete gym access and example diet. The saved Surface visibly contains three separate days, exercise names, sets, repetitions, rest, progression and caveats. Its Chat confirmation describes that actual committed content. The complete plan remained after reload and Gateway restart.                                                                                                                      |
| Weight/history/Chart | Requested a Weight tracker with current-value summary, dated history and a line Chart over that history, initially without invented measurements. Then sent exactly `mi sono pesato e sono 74 kg`. Without refreshing, the summary displayed `74 kg`, history contained one `2026-10-01` / `74` record, and the visible Chart and its accessible label included that same point. Table and Chart both bind to `measurements`. All three remained after reload, on the other authenticated client, and after restart.                                                                                                     |
| Full presentation    | Sent exactly `Make the gym plan Surface full-row.` The Agent read the existing Surface and committed `set_surface_presentation`. Both clients at 1280 px desktop width had two 465 px columns with a 16 px gap; the plan occupied the entire 946 px row (`grid-column: 1 / -1`). Canonical comparison before/after proved tree, state and Pin unchanged. Exactly one matching `surface.presentation` Event committed. Form records, complete plan, 74 kg visualization and `full` remained after reload, PWA disposal/reopen, and a same-root Gateway restart. The second open client reconnected without manual reload. |

The PWA was disposed by navigating away and then reopening its Space route. The public canonical
snapshot was compared across the final restart: all three authored Surfaces retained identical
trees, states, Pin and presentation. No data migration or deletion was used to make the run pass.

## Observed errors and common fixes

The initial attempt exposed missing control guidance in the shared authoring contract and noisy
provider JSON-Schema union diagnostics. It did not count as a passed Form smoke. The common guide
now explains Form ownership, typed plans, string drafts/numeric submission, Table columns, and
atomic root replacement. `AgentRunner` validates unchanged ToolDef Zod inputs before provider
JSON-Schema preparation and reports precise paths. The protocol also rejects layout/decorations
or blank text as the sole complete Surface content. These changes apply to every Model connection;
no subscription-specific prompt or domain parser was introduced.

During the accepted run, ChatGPT still made malformed calls, including invalid Form declarations.
Those calls returned validation errors and created no partial tracker; it corrected them and then
read the saved result. The failed Table recomposition attempt was retried after the common patch
guidance was corrected. Passing evidence is the eventual canonical UI result, not an assertion that
models never produce invalid arguments. Deterministic acceptance separately exercises rejected
mixed writes, preserved Form drafts/errors, retry and pinned Tree proposals.

## Parent acceptance audit

| Parent requirement                                                     | Public evidence                                                                                                                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed contracts and complete visible/operable results                 | [33-Atom conformance matrix](29-atom-conformance-matrix.md), protocol `atom-closed-union`, `surface`, `action-operability`, content/control/layout suites; catalog contract/interaction suites |
| Local Form draft, complete submit, error preservation and keyboard use | Catalog `atoms-form`, `atoms-form-confirmation`, `form-number`; PWA Surface recovery suites; clean `local-vps.spec.ts` and `fast-actions.spec.ts`; actual run above                            |
| Explicit one-series Chart and shared 74 kg source                      | Protocol/catalog Chart suites; clean combined Local VPS journey; actual `measurements` binding in the real-run record                                                                          |
| Typed presentation, explicit current request, independent Pin/order    | Protocol presentation schema, public presentation engine/tool/authority tests, template and Tree-proposal suites; two-client Local VPS journey and actual layout comparison                    |
| Atomic create/patch/recompose/materialize/proposal/replay              | `semantic-write-acceptance`, `surface-engine`, `templates`, `tree-proposal`, `surface-commit`, frozen-corpus tests; unknown names remain inert visible read projections                        |
| Honest Chat and Connection parity                                      | Public `AgentRunner` provider-tool/parity suites, canonical Chat-confirmation suites, invalid-authoring browser step; actual subscription tool calls and confirmed content                     |
| Realtime convergence, cache, reload, reconnect, restart                | Clean two-session `controls`, `action-controls`, `agent-actions`, `fast-actions`, `agent-queue`, `atom-wire-compatibility` browser suites; actual two-client/restart results                   |

The final review also reproduced two previously hidden authoring gaps. An unsupported root
placement field could be stripped by the create tool; strict focused/global tool inputs and the
canonical Surface parser now reject it with a precise path. A pinned `patch_tree` returned a
numeric proposal id that Chat treated as unconfirmed; a test using the actual tool result now proves
that Chat says the change awaits the user's decision. Neither failure is counted as a committed
Surface change.

The final nine authored browser journeys passed from isolated Local VPS roots. They include the
combined four-scenario mock regression, malformed authoring refusal, all remaining Action owners,
the genuine UnknownAtom fallback, queue-capacity refusal/retry, and restart/reconnect. Mock journeys
are deterministic regressions; the real-account evidence above is their separate non-CI complement.

Final `pnpm check` passed lint, formatting, every package typecheck, all **3,696 tests in 292 files**,
and production build. A full-suite failure exposed a one-second terminal-frame polling deadline;
the isolated public-loop reproduction passed in 889 ms, and the bounded wait now allows five seconds
without changing its terminal-frame or outcome assertions. The complete suite then passed.

Transient profiles, cloned credentials, notes, learning files and browser test artifacts are removed
after verification. Durable sanitized proof records remain in `docs/references/`.
