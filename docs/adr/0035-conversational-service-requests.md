# Conversational service requests and repository read access

Status: accepted

Work: [#197](https://github.com/Ic3b3rg/veduta/issues/197), with implementation slices
[#198](https://github.com/Ic3b3rg/veduta/issues/198), [#199](https://github.com/Ic3b3rg/veduta/issues/199),
[#200](https://github.com/Ic3b3rg/veduta/issues/200), and [#201](https://github.com/Ic3b3rg/veduta/issues/201).
The reporter approved the general correction and all four slices. This extends the initial
repository profile in [ADR-0034](0034-veduta-owned-mcp-client.md) and reuses the lifecycle in
[ADR-0033](0033-chat-initiated-service-connections.md).

## Conversation and authority

English regular expressions at setup, Skill selection, and execution interpreted the same request
differently. A repository supplied in a follow-up was rejected, while a bounded latest-message
request required an artificial subject/category filter. User phrasing is not an authorization grammar.

The Gateway now makes one tool-less Model connection call to resolve each accepted user Chat
request. It supplies the current user message, bounded prior user messages from the same Chat
scope, prior clarification state, the clock/timezone, and available Space/account metadata.
Assistant text, Events, tool output and external content are excluded. A prior message may resolve
a reference or an active clarification; a completed, cancelled or unrelated task is not standing
permission. A bare reference without an active task must not start work. The inference request
uses ModelRouter and the existing inference-only bridge, with no extra agent or provider tools.

A strict schema describes supported read operations, owning Space, resource/account bounds and
finite result limits. The Gateway persists that resolution against the accepted Chat turn in the
same durable timeline used for connection continuation. Setup, applicable Skills, and tool handlers
consume it. Handlers require the initiating turn to be running, the original user text to match,
and the owning Space to be current. Model-generated tool arguments cannot replace these bounds.
Current connection health, authorization revision and Space grants remain execution-time checks.
Interpretation remains a model capability, not proof of a user's semantic intent; these independent
resource and effect checks remain necessary. Explicit existing issue writes retain their separate
exact-input L1 approval path; this decision adds no writes.

Material account ambiguity produces a durable clarification with the pending operation. An account
answer completes that task without requiring the original instruction again. Account identity is
checked at setup and execution; naming another account never silently selects the first one.
The accepted operation pins both the canonical account and Service connection ID, so two
credentials for the same GitHub login remain distinguishable through setup and every read.
Invalid resolution fails before service access. Missing access uses the protected Connection
attempt; passive verification does not fetch requested content. Existing duplicate-submission,
restart and uncertain-effect retry semantics remain in force.

## Latest Gmail message

An unqualified latest-message summary means one newest message in the Inbox. Explicit folder,
account, count, time and query filters take precedence. No implicit unread or topic filter is added.
Summary preserves all labels. Raw bodies remain transient and only quarantined, validated Mail
summaries reach the Agent, Mailbox Surface and Event log.
Both quarantined reader prompts include the actual validation schema, including enum values,
array bounds and date formats; malformed output still fails validation. Codex inference threads
are ephemeral: the subscription inference boundary must not materialize raw reader prompts in
its own conversation rollouts. The Gateway retains its normal validated Chat timeline.

Gmail documents `internalDate` as Inbox ordering, but `messages.list` exposes no sort parameter or
ordering guarantee. Newest-N selection therefore establishes a complete recent interval with at
most 20 IDs, using at most 32 additional timestamp probes if the initial list is paginated. Every
probe intersects the original query. Metadata-only gets establish timestamps; only the newest N
bodies are retrieved. An interval that cannot fit the bound, including too many messages at the
same timestamp, produces an honest limit outcome instead of an arbitrary first-result claim.
Each provider request and the final save recheck access. A changing mailbox is not a provider
snapshot; the result describes the messages observed during that bounded check.

Sources: [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[Message.internalDate](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages),
[Gmail search](https://developers.google.com/workspace/gmail/api/guides/filtering).

## Expanded GitHub read profile

New GitHub connections review Metadata, Contents and Issues read access. A fine-grained PAT
controls provider authorization; each enabled Space defaults to all repositories authorized by
that connection and may restrict access to an explicit list. Repository names compare without
case sensitivity. Existing single-repository issue grants keep their original fields, actions and
scope. Broadening them requires a separate protected review and authorization upgrade. Saving
changed restrictions replaces the previous broad-profile grant for that connection and Space.

Discovery uses the authenticated GitHub `GET /user/repos` metadata endpoint, with 20 repositories
per page and at most five pages in a Chat turn. Space restrictions and an optional owner filter
apply before any metadata reaches the Agent, Surface or Event. Pagination is explicit; partial
results do not claim to enumerate every repository. There is no ambient repository enumeration.
This native metadata adapter is part of the reviewed read profile, alongside MCP, and has a fixed
GitHub API destination, no redirects, response byte limits and request deadlines. It does not use
public repository search as a substitute for authenticated access.

The MCP executable and supported platforms remain those of ADR-0034. Account
verification and discovery of the two selected schemas run without repository content. Each
MCP child still exposes one selected tool: `list_issues`, or the newly reviewed `get_file_contents`.
The latter's input schema was obtained from the pinned Darwin arm64 v1.12.2 executable via the
original sandbox and API-only CONNECT proxy, with a dummy credential and no content call. Its fixture
is `packages/daemon/src/fixtures/github-get-file-contents-v1.12.2.json`, compact JSON SHA-256
`5d7f569392e212ac9b5b8a985d986c69f317f3052f265626498aa3d0a4ec2bb8`.
The connection review hashes the ordered pair of reviewed issue/file tool identities and hashes;
each child independently verifies its selected schema at execution. Unsupported platforms remain
Unsupported; this change does not claim Linux isolation proof.

Real-provider proof exposed a Darwin TLS failure in the original CONNECT transport. Go 1.25.12
in the pinned executable requires Security.framework access to its executable's directory metadata
and the `trustd` service. A local missing-intermediate certificate probe demonstrated that allowing
`trustd` could fetch a certificate outside the child's allowed TCP destination. That allowance is
therefore denied. Instead, the pinned server's supported loopback API-host configuration points at
a per-session Gateway HTTP relay. It accepts only its exact loopback Host and a random session
credential, GET/POST, and the fixed `/api/v3/` or `/api/graphql` paths. The relay translates those
paths to `https://api.github.com`, injects the real PAT only upstream, verifies TLS normally, refuses
redirects, and forwards only explicit request headers. Bounds are four concurrent requests, 1 MiB
per request/response, and ten seconds total; session cancellation aborts pending requests.
This replaces the CONNECT detail of ADR-0034. Direct TCP still reaches only the local relay;
private file reads, directory listing, writes and Mach service lookup remain denied. The relay
enforces destination and transport constraints; selected-tool, grant and L1 checks continue to
enforce operation authority.

Sources: pinned [API-host resolver](https://github.com/github/github-mcp-server/blob/v1.12.2/pkg/utils/api.go),
[Go Darwin verifier](https://github.com/golang/go/blob/go1.25.12/src/crypto/x509/root_darwin.go),
[Apple trust network behavior](<https://developer.apple.com/documentation/security/sectrustsetnetworkfetchallowed(_:_:)>).

File reading uses bounded GitHub commit/tree metadata to pin a revision and establish the exact
path, type, size and blob SHA before invoking MCP. This prevents v1.12.2's default-ref and suffix
path fallback behavior from silently reading another file or revision. Default `HEAD` resolves
the default branch; an explicit ref must resolve or fail. Subsequent navigation in the same turn
keeps the pinned commit. Directory reads expose at most 100 entries; paths have at most 12
components. A turn permits eight reads and each text body is at most 32 KiB. Symlinks/submodules
are reported without following them. Binary and oversized files are distinct outcomes.

Only bounded MCP text resources are accepted as file bodies. The Gateway recomputes the Git blob
hash against pinned metadata before exposing text. It constructs source URLs from the authorized
repository, commit and path, not server-provided download links. Content is never executed or
treated as authority. Results retain Untrusted origin, source and revision attribution; durable
Surface writes use protocol validation and their normal matching Events. Revocation cancels
in-flight reads and a final grant check prevents stale results from being saved.

Sources: [authenticated repositories](https://docs.github.com/en/rest/repos/repos#list-repositories-for-the-authenticated-user),
[commit SHA representation](https://docs.github.com/en/rest/commits/commits#get-a-commit),
[Git trees](https://docs.github.com/en/rest/git/trees#get-a-tree), and the pinned
[file reader implementation](https://github.com/github/github-mcp-server/blob/v1.12.2/pkg/github/repositories.go).

## Verification boundary

The primary regression seam is accepted Gateway Chat through the real registry to controlled
provider transports, persistent responses, Surfaces and Events. Tests include multilingual and
split requests, account clarification, newest-message ordering, empty results, setup continuation,
Space restrictions, pinned refs, missing/binary/oversized paths, revoked grants, changed file
content and actual MCP stdio framing. PWA checks cover the protected review and restriction controls.
Fixture transport/model proof is recorded separately from real-provider/model proof; neither
substitutes for the other. No new ambient watches, mail mutations, attachments or GitHub writes
are introduced.
