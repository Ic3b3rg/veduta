# GitHub MCP disposable write and recovery proof

Work: [#180](https://github.com/Ic3b3rg/veduta/issues/180).
Boundary: [ADR-0033](../adr/0033-chat-initiated-service-connections.md),
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md), and
[ADR-0035](../adr/0035-conversational-service-requests.md).
Observed: 2026-10-05, Darwin arm64.

## Result

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

Issue #180 remains incomplete: successful real creation, exact title/body read-back, numeric issue
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

## Remaining user proof

After the reporter grants **Issues: Read and write** for the disposable repository and completes
protected reconnect, repeat the exact bounded write journey from its review. Approve the prepared
L1 decision once, verify the returned numeric issue and exact title/body/source, inspect its owning
Space Surface and Event after reload and Gateway restart, and repeat the same decision resolution
to establish no second write. Remove only that uniquely tagged issue and verify its absence.
Keep that successful proof separate from the denied attempt and from controlled-inference evidence.
