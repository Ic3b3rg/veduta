# Veduta-owned MCP client behind AgentRunner

The initial single-repository profile below is extended by
[ADR-0035](0035-conversational-service-requests.md) for optional Space restrictions, authorized
repository discovery and bounded file reads. Existing grants are not broadened automatically.

Issue #179 selects the first MCP profile for external reach. The Gateway owns MCP transport,
credentials, discovery, tool selection, authorization, execution, cancellation, and Trace.
`AgentRunner` receives only Veduta `ToolDef`s. A Model connection provides inference only:
provider-native MCP, web search, command execution, and approval facilities stay disabled under
[ADR-0004](0004-typescript-pi-agent-core.md) and
[ADR-0014](0014-subscription-inference-boundary.md). The user-facing connection lifecycle is
[ADR-0033](0033-chat-initiated-service-connections.md).

## Initial profile and reviewed proof

The first transport is **MCP stdio**. The Gateway launches an exactly pinned, reviewed local
server binary as a supervised subprocess and owns its lifetime. This is not a shell command
assembled by the model: executable path and arguments come from reviewed configuration, no shell
interpolation occurs, and the process receives a minimal environment and explicit working/data
directory. The client supports the `2026-07-28` per-request lifecycle and `2025-11-25` handshake
fallback. It probes `server/discover` first, selects a mutually supported modern version when
offered, and falls back to `initialize` only for a legacy response or timeout. An older version is
Unsupported until tested and explicitly added. The client handles paginated `tools/list`,
`tools/call`, tool-list invalidation, cancellation, and clean process termination. It advertises
no sampling, roots, elicitation, prompts, or resources in the first slice; a server requiring one
of those for a required behavior is Unsupported. Streamable HTTP, legacy SSE, server-initiated
requests, and arbitrary custom transports need separate reviewed implementation and are
Unsupported in this initial profile. The Hub may still inspect their definitions but may not
report them ready.

The first reviewed non-mail service is the official
[GitHub MCP Server v1.12.2](https://github.com/github/github-mcp-server/releases/tag/v1.12.2),
published 2026-09-16. The Linux x86_64 **release archive**
`github-mcp-server_Linux_x86_64.tar.gz` has GitHub-published
`sha256:95843162759da2c31dde082dd145be35db82164594796c294414b69790c2290e`. Its extracted
`github-mcp-server` executable hashes to
`sha256:b7a96bf79c68c0d4d0cdb5713e9ff36a1730b87ee3ae710e2e6189f398d7c1aa`. The reviewer
verifies the archive first, rejects escaping or unexpected entries, then checks the extracted
executable and complete file inventory before launch; other architectures need their own reviewed
archive and executable digests. The exact archive, binary, source tag, checksums, and discovered
tool schemas are shown before authorization. A fine-grained GitHub PAT
limited to one disposable repository and Issues permissions is entered in the authenticated PWA,
stored in the Veduta vault, and supplied to the child only at launch through a scoped secret
environment variable. It never appears in process arguments, Chat, model context, Events,
Surfaces, or Trace. The server's stdio child needs outbound reach to GitHub's API; no local vault
mount or arbitrary filesystem access is granted. Its process isolation and destination limits use
[ADR-0032](0032-reviewed-extension-hub.md)'s executable boundary. A PAT is the initial auth
profile; generic MCP OAuth and GitHub's remote hosted endpoint are separate work.

The inspected Linux archive has exactly three regular files: `LICENSE` (1,063 bytes,
`sha256:9e48ecfa18e2b15169746a3c97beda4d1d6c6796097038498ca434ca7e0ccd44`),
`README.md` (113,197 bytes,
`sha256:0686b41067fd437abbde4b473c394fe2365e5ad2ae81c21b9f988735359c9666`), and
`github-mcp-server` (25,493,688 bytes, digest above). A changed inventory is a different
artifact requiring review.

The same official v1.12.2 release was separately reviewed for the Darwin arm64 development host.
`github-mcp-server_Darwin_arm64.tar.gz` has GitHub-published
`sha256:7e6c5aec43f26b82d3580e77a4ee26872bcd34b48c9a08d0eaef48b5d0563904`.
Its three regular files are `LICENSE` and `README.md` with the sizes and digests above, plus
`github-mcp-server` (24,733,314 bytes,
`sha256:8d7686ec4c5f2a9614c75b329163abaaa915a1cc92423253df4ee7ba2df88de0`).
This review permits local proof on that host; each other architecture still needs its own reviewed
artifact and exact inventory.

The Darwin arm64 runtime launches that executable through the host's `sandbox-exec` with a policy
that denies reads of the Gateway data root and the user's home except for the exact reviewed
executable.
A per-session loopback HTTP relay maps only the pinned server's REST and GraphQL paths to
`https://api.github.com`, with normal Gateway TLS verification, no redirects, bounded bodies and
deadlines. The child process's network sandbox permits only that relay port. Its minimal environment
contains a random session credential and the local API host; the real PAT stays in the Gateway.
See [ADR-0035](0035-conversational-service-requests.md) for the transport correction and proof.
A profile without a verified process boundary
must fail closed before MCP discovery. The Linux archive is pinned and inventoried, but Linux
activation remains Unsupported until its process and egress boundary has its own runtime proof.

For the first read, review and select only the GitHub `list_issues` tool, with a repository
argument fixed by the Space grant. Tool discovery and account validation cannot list issues.
The reviewed v1.12.2 `list_issues` input schema is captured in
`packages/daemon/src/fixtures/github-list-issues-v1.12.2.json`; its compact JSON SHA-256 is
`56536b79a8bd99d49767afbb6fea3dafad31b898094e88496b6d023a07fd9119`.
The user requests a bounded list of open issues; the Agent calls that one tool, then creates a
validated, source-linked Surface in the owning Space with a matching Event. The separate write
profile selects only `issue_write` from the same v1.12.2 executable and fixes its method to
`create`. Its reviewed schema is captured in
`packages/daemon/src/fixtures/github-issue-write-v1.12.2.json`, with compact JSON SHA-256
`97fade9d761e39e29714162058cbcc5a484d65372be703889dd86f9d062c811b`. Write needs its
own repository-scoped Connection attempt and Space grant; a read grant cannot authorize it. The
prepared exact repository, title, and body require an L1 Approval card with no allowlist or editable
fields. The MCP response and a GitHub API read-back confirm the created issue before the Gateway
writes a source-linked Surface. A durable effect record prevents replay of a confirmed write and
refuses automatic retry of a started write whose outcome is unknown after a timeout or crash. The
user must inspect the repository before requesting another write. The same scenario needs BYOK
and ChatGPT subscription fake Model connection proof, plus a disposable real GitHub repository and
fine-grained token.

## Discovery and per-Space eligibility

An MCP connection has a stable Gateway-wide id, pinned server identity/digest, protocol version,
account identity, credential reference, and health. Initial `tools/list` is paginated, bounded by
count/bytes/time, and treated as Untrusted even when the binary is reviewed. Veduta validates each
name, JSON Schema, description length, and result size, then stores a reviewed tool identity and
schema hash. Duplicate or malformed tools are rejected individually when safe; a missing required
tool blocks readiness. A changed required schema or new tool is hidden until reviewed. The Agent
sees only selected tool names, a bounded sanitized description, and schemas wrapped as `ToolDef`s;
an unselected tool is not callable by name. Tool annotations such as `readOnlyHint` are hints,
never the effect authority. Gateway review assigns an effect class and resource restrictions.

An authenticated SpaceCapabilityGrant from ADR-0033 selects tools and a resource scope for one
Space. The Gateway rechecks the grant, connection health, tool schema hash, account, and resource
arguments on every call and at an Automation occurrence. The MCP server itself is not asked to
decide which Space owns a result. Multiple Spaces may use one connection only after separate
grants; each output, Surface, and Event remains in the initiating Space. A disabled grant or
connection removes ToolDefs from new turns and cancels in-flight calls. Restart relaunches the
same pinned server only for an enabled, authorized connection, rechecks discovery, and never
silently widens the tool set. Reconnect may restore the same id only for the same account identity.

MCP descriptions, annotations, error messages, links, and results remain Untrusted content with
origin `{connection, server digest, tool, call}`. Interactive work may bring bounded content into
the current Agent turn; unsolicited content uses the quarantined reader. The Gateway rejects
oversized or unsupported result media, strips secrets from diagnostics, validates declared output
schemas where provided, and never treats a result's instruction text as authority. Durable
Surface state passes `@veduta/protocol` validation and uses the normal Surface commit. An
external write travels through a prepared, exact L1 Pending decision; destructive or credential
management actions are L2 and blocked in the first profile. The wrapper can gate a declared tool
call and resource scope, but it cannot prove that arbitrary server code performs only its declared
semantic effect. The reviewed binary, limited provider credential, process boundary, and runtime
evidence are therefore part of the trust decision; no universal sandbox is claimed.

The client bounds stdout frames, stderr diagnostics, tool count, call concurrency, elapsed time,
and result bytes. User cancellation sends the MCP cancellation notification, then terminates an
unresponsive child after a grace period; cancellation does not assert that a remote effect was
undone. Authentication failure, missing binary, incompatible protocol, required-tool drift,
malformed output, child exit, provider outage, and revoked credentials produce distinct truthful
health and recovery states. A server asking for unsupported features is not partially advertised
as ready. Disabling or removing a connection stops the child and drops its credential reference
without deleting prior Space outcomes.

The [MCP stdio specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
defines version detection and cancellation, and the
[tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
defines discovery, schemas, and annotations. The [official GitHub server](https://github.com/github/github-mcp-server)
documents the local server, read-only mode, and GitHub toolsets. Provider-native MCP was rejected
because it would make external capabilities depend on the selected Model connection; launching
arbitrary `npx` commands from model text was rejected because it would erase provenance and
approval of the exact executable.

Status: accepted
