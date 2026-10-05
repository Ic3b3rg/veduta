# GitHub MCP disposable write and recovery proof

Work: [#180](https://github.com/Ic3b3rg/veduta/issues/180).
Boundary: [ADR-0033](../adr/0033-chat-initiated-service-connections.md),
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md), and
[ADR-0035](../adr/0035-conversational-service-requests.md).
Observed: 2026-10-05, Darwin arm64.

## Initial permission-denied attempt

The reporter authorized one disposable test issue in `Ic3b3rg/poppy-review-proof`, followed by
removal. The configured account could read that repository, but its saved fine-grained PAT could
not create an issue. After an exact L1 Pending decision was approved in the authenticated PWA,
the real GitHub MCP request returned:

- `POST /repos/Ic3b3rg/poppy-review-proof/issues`: HTTP 403.
- GitHub's reason: `Resource not accessible by personal access token`.
- The Pending decision became terminal with outcome `failed`; the Space recorded one safe
  `approval.outcome` Event. No issue-created Event or success Surface was written.
- An authenticated repository read found no uniquely tagged test issue. There was no remote
  artifact to delete or close.

At that point, issue #180 remained incomplete: successful real creation, exact title/body read-back, numeric issue
identity, write-result persistence, confirmed-write retry, and deletion of the created test issue
were not proved. Repository account roles do not establish the PAT's Issues write permission.
No further write was attempted after the specific permission denial was established.

## What used the real service

A private disposable data root had mode `0700`. Only the needed GitHub credential was resolved
internally through `SecretsVault` and copied into a fresh encrypted vault; no original Space,
grant, account lifecycle state, or Agent session was imported. The credential stayed inside the
private harness and protected PWA token form, never tool output or model context.

The harness used production `buildServer`, `GithubMcpService`, service lifecycle routes,
AgentRunner, tool registration, trust layer, and Pending-decision resolution. GitHub account
verification, MCP discovery, repository reads, and the attempted write used the real provider.
No MCP responses or GitHub responses were fabricated. A diagnostic observer of actual fetch
responses established the HTTP 403; it changed no request or response.

The pinned official GitHub MCP Server v1.12.2 executable ran under the existing Darwin process
boundary and Gateway API relay. Its SHA-256 was
`8d7686ec4c5f2a9614c75b329163abaaa915a1cc92423253df4ee7ba2df88de0`, matching the accepted review.
The write review displayed the official release source, version, archive and executable digests,
write-tool schema digest, execution host, requested Issues write permission, and only
`Ic3b3rg/poppy-review-proof`. The connection was unavailable before verification. An existing read
grant did not authorize `issue_write`.

Chromium used a virtual passkey against Veduta's production authentication implementation and
fresh persisted auth state. Inference used Veduta's explicit Local VPS mock control because the
saved real Model connection reported expired authorization. The real-model Chat observations in
[reference 32](32-conversational-service-requests-smoke.md) remain separate evidence. This run does
not claim real-model interpretation or Linux support; Linux activation remains owned by
[#196](https://github.com/Ic3b3rg/veduta/issues/196).

## Observed browser journey

The first requested real `list_issues` read produced a protocol-validated GitHub issues Surface
in a newly created Space. A second fresh Space received neither that Surface nor a grant.
The browser then initiated a separate exact issue-creation request. Before authorization it
reviewed the write profile; after account verification it explicitly granted the owning Space.
That resumed the same accepted job and prepared one L1 Pending decision containing the exact
repository, title, and body. The repository was checked again and the tagged issue was absent
before the browser approved that exact decision. The subsequent real call was denied as described
above; setup readiness was not treated as evidence of write success.

A separate read-only browser run made no issue-write request and proved:

1. The real read Surface and its matching Space Event remained after reload and Gateway restart;
   reload produced no additional read Surface.
2. **Disable access** in the PWA disabled the exact Space grant. A new service call was refused
   before dispatch, while the previous Surface remained.
3. A new requested read entered protected recovery. **Cancel setup** left its attempt `cancelled`
   and continuation `unclaimed`, performed no requested read, and preserved the existing result.
4. **Disable** blocked the account. **Reconnect** reviewed only `list_issues` on the disposable
   repository, verified the same `Ic3b3rg` identity, and retained the stable connection id.
   Verification alone restored no Space access. The browser explicitly selected the original
   Space and saved a new grant.
5. The resulting grant permitted only the reviewed repository and read action. Another Space,
   `Ic3b3rg/veduta`, and `issue_write` remained ineligible.
6. A new explicit read succeeded after reconnect. Both valid read Surfaces remained after a
   second Gateway restart, with no duplicate result from refresh.

One preceding recovery run exceeded a five-second browser-shell wait on immediate reload after
the second read had already saved its Surface. A fresh run with unchanged assertions and added
browser diagnostics passed. This bounded observation is not reported as a diagnosed product bug.

## Controlled coverage and checks

Fresh focused tests passed: 10 files, 40 tests. The suites covered the GitHub service and effect
ledger, connection persistence/routes/management, MCP stdio framing, Darwin execution boundary,
API relay, and AgentRunner tool/trust parity. `provider-tool-parity.test.ts` specifically exercised
the reviewed GitHub read ToolDef through BYOK and subscription inference. The exact approved write
route used a controlled provider in `service-connection-routes.test.ts`.

The effect-ledger tests proved that a started write with an uncertain outcome is not replayed
after restart, confirmed effects reuse their numeric identity, and another request cannot reuse
that identity. Stdio tests proved cancellation without asserting that an external effect was
undone, required-tool drift rejection, and immediate network cancellation on shutdown. Those are
deterministic proofs, not a deliberately ambiguous real GitHub write or provider-side token
revocation. The live run did not revoke or modify the original PAT.

The full `pnpm check` belongs to the coordinating QA run and is not claimed by this scoped proof.
The temporary harness itself passed ESLint and formatting.

## Preservation and cleanup

After each disposable run, byte-hash comparisons found all 11,932 original installation files
unchanged, including Service connections and grants, Model connections, encrypted vault, and
vault key. The production Gateway was never restarted or mutated by this proof. A scan of the
successful recovery root's 29 textual files found zero occurrences of the PAT.

Disposable browser contexts and Gateway processes were stopped. The private copied credentials,
vault key, auth state, Spaces, grants, Surfaces, Events, and MCP executable were removed with the
temporary data roots. No original or pre-existing repository issue was touched. No commit,
push, PR, or Veduta issue-tracker mutation was performed by this scoped proof.

## Initial follow-up checklist

The initial follow-up checklist, fulfilled by the corrected proof below, was:

After the reporter grants **Issues: Read and write** for the disposable repository and completes
protected reconnect, repeat the exact bounded write journey from its review. Approve the prepared
L1 decision once, verify the returned numeric issue and exact title/body/source, inspect its owning
Space Surface and Event after reload and Gateway restart, and repeat the same decision resolution
to establish no second write. Remove only that uniquely tagged issue and verify its absence.
Keep that successful proof separate from the denied attempt and from controlled-inference evidence.

## Updated-permission retry: response defect reproduced

The reporter subsequently granted Issues read/write and authorized a retry. The collaborative
T3 browser exercised the exact reviewed write profile, real account verification, the explicit
Space grant, and a separate L1 Pending decision. The disposable instance used a controlled
authenticated QA session and mock inference; this retry does not claim a real passkey sign-in
or real-model interpretation. The MCP process and GitHub responses were real.

Approval at 18:24:14 UTC created uniquely tagged issue **#3** in the authorized repository, with
the exact title/body and creator `Ic3b3rg`. Veduta nevertheless recorded a failed decision with
`GitHub issue outcome is unknown; inspect the repository before retrying`. Its effect remained
`started`; no issue-created Event or result Surface appeared. Repeating the terminal decision
after Gateway restart returned the existing failed outcome and produced no duplicate issue.

The original MCP frame was not captured. The
[pinned upstream CreateIssue implementation](https://github.com/github/github-mcp-server/blob/85598ba6e1256f7ebf4867b95d63b833c4549264/pkg/github/issues.go)
constructs a minimal response containing a string database `id` and the issue's HTML `url`.
The existing decoder recognized only a numeric `number` field. A source-grounded service
regression reproduced the exact observed error; this is documented as
[bug #223](https://github.com/Ic3b3rg/veduta/issues/223), rather than inferred permission failure.

The guarded cleanup deleted only issue #3. A subsequent native read returned **HTTP 410 Gone**,
and an all-issues read returned HTTP 200 with zero issues or matching markers. The temporary
Gateway, data root, browser session and one-use loopback bootstrap endpoint were removed.
All 11,932 original installation file hashes stayed unchanged, and a credential scan of the
30 disposable textual files found no PAT occurrence. The original Gateway was not restarted.

## Corrected real-service proof

The localized fix for [#223](https://github.com/Ic3b3rg/veduta/issues/223) resolves a canonical
issue URL only inside the reviewed repository and then reads the exact approved title and body
back from GitHub before confirming the effect. A database `id` is never treated as an issue number.
Foreign, malformed, noncanonical, conflicting, and unsafe identities remain uncertain and cannot
trigger an automatic second write.

The corrected retry used the collaborative T3 browser and the real pinned MCP executable.
A passive observer captured the actual creation response: string `id`, string `url`, and no
`number` field. The URL identified **issue #4** in `Ic3b3rg/poppy-review-proof`. Native read-back
verified the numeric identity, exact approved title and body, and creator `Ic3b3rg`.
The unique marker was `veduta-180-2026-10-05T18-35-51-772Z-224fc3ef`.

The browser reviewed the exact write profile, verified the account, explicitly granted only the
owning Space, and separately approved one L1 Pending decision. Before approval, no write effect
existed. After approval, the PWA displayed an executed decision and a validated, source-linked
GitHub issue Surface. The effect was confirmed with numeric identity 4, and the Space contained
exactly one `github.issue.created` Event. The other Space had no GitHub grants or results.

Reload and two disposable Gateway restarts preserved the write result and its Event. Repeating
the terminal decision returned the executed outcome; retrying the confirmed effect reused identity 4. The repository still contained only the one uniquely tagged issue, and no second creation Event
appeared. Disabling Space access rejected a fresh write before dispatch and preserved the result.
Same-account reconnect retained the connection identity but restored no grant automatically.
Only an explicit grant restored access to the reviewed repository and action.

After an explicit read-profile reconnect and grant, a new T3 Chat request listed issue #4 with
its canonical source. Its protocol-validated read Surface and matching Event persisted through
reload and the second restart. The read Surface hash remained
`2faf6d6d86d527a16efa9dfe3901d72a959ba7a2b1db69f804d2ff4c2a1ad56d`.
Another Space and `Ic3b3rg/veduta` remained outside the reviewed grants.

An earlier fresh UI read returned the generic failure `The GitHub issue read failed`.
Its provider cause was not captured and remains unclassified. A bounded subsequent direct
production-service MCP read returned HTTP 200 with an empty issue list; that diagnostic was not
a UI proof. The later explicit browser reconnect and successful Chat read are separate recovery
evidence. No repeatable product defect was diagnosed from the initial generic failure.

This retry used controlled inference and a disposable authenticated session seeded only in the
copied AuthStore through a one-use loopback bootstrap. Protected production routes and session
verification were exercised, but this retry does not prove a real passkey sign-in or real-model
interpretation. Existing real-model journeys and deterministic provider-parity tests are separate
evidence. Linux activation remains owned by #196. Network uncertainty was not deliberately induced;
the regression tests cover uncertain effects without claiming a real provider-side rollback.

The guarded cleanup deleted only issue #4. A saved-credential native read returned **HTTP 410 Gone**;
an all-issues read contained no issue #4 or matching title/marker. The disposable Gateway, private data
root, bootstrap material, and browser QA session were removed. All 11,932 original installation
file hashes matched, including protected configuration, grants, credentials, and vault material.
A scan of 30 disposable textual files found zero PAT occurrences. The original Gateway was not
restarted or mutated. Neither the QA harness nor credentials are committed.

## Fix validation

The official minimal response first reproduced the unknown-outcome error in a failing regression.
After the fix, focused service, effect, route, stdio, and provider-parity tests passed. The route
fixture now uses the actual upstream `{id, url}` shape. Rejection cases cover database ids without
URLs, conflicting identities, foreign repositories and hosts, malformed paths, unsafe numbers,
and noncanonical URL forms. Existing read-back validation and no-replay behavior remain intact.

The coordinating run's full `pnpm check` passed: lint, formatting, type checking, all **3,897**
package tests, and build. Two independent code reviews found no actionable implementation findings.
The successful real-service proof above establishes the localized fix's runtime behavior; it does
not imply deployment to the untouched original Gateway.
