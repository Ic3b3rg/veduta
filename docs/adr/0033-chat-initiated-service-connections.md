# One Chat-initiated connection journey across services

Issue #178 defines a common user journey for supported external services. A user asks the Agent in
focused Chat, or in global Chat with an explicitly resolved target Space, to perform a concrete
task; the Agent discovers one reviewed capability, explains its actions and access, and opens a
durable setup attempt. An ambiguous target Space requires clarification before setup. The
authenticated PWA and, where used,
the provider's browser consent collect credentials and authorization outside Chat and model
context. On verified readiness Veduta resumes the **same accepted request** once. Gmail's native
OAuth path and the pinned GitHub MCP server from
[ADR-0034](0034-veduta-owned-mcp-client.md) are the first two mechanisms. This is a connection
journey, not a universal Mailbox model or a general external-package installer.

## Identities and state

The Gateway owns three separate records:

1. A `ConnectionAttempt` has a stable id, original Chat submission/turn id, initiating Space,
   requested job, capability, chosen provider/account hint, reviewed scope, and lifecycle state.
   It is persisted before any authorization handoff and is idempotent for the original Chat
   submission. A new user request may start a new attempt; retrying the same submission cannot.
2. A `ServiceConnection` has a stable Gateway-wide, non-secret id, service/provider identity,
   verified account identity, execution mechanism and host, credential reference, granted provider
   scopes, health, and revision. Two accounts of one provider remain separate. The connection owns
   no Space, Surface, memory, or Automation.
3. A `SpaceCapabilityGrant` names one Space, connection id/authorization revision, approved resource scope,
   allowed actions/tools, and enabled state. It is the only way a Space or its Automation uses the
   connection. Adding a second Space requires a new explicit grant; no result or memory is copied.
   Routine token refresh does not change the authorization revision; account or scope changes do.

The attempt moves through `draft -> reviewing -> authorizing -> verifying -> ready`, with terminal
`cancelled`, `failed`, or `unsupported` states and a recoverable `needs_reconnect` state after a
previously ready connection loses authorization. `ready` means the exact required capability was
proved, not merely that a token exists. A connection can be `ready`, `degraded`, `needs_reconnect`,
`disabled`, or `removed`; the attempt and connection states cannot stand in for each other. The
Gateway stores a safe reason and next action for every non-ready state. The PWA presents the same
state names and actions for Gmail and GitHub while showing mechanism-specific scopes and steps.

Chat may identify a supported service, prepare a bounded attempt, explain scope, and deep-link to
authenticated Review. Chat cannot collect or accept a secret, authorization code, or persistent
grant, and cannot mark a connection ready. Before authorization, the PWA shows the account hint
if one exists, requested provider scopes, allowed actions, execution host, and owning Space. The
authenticated user confirms the request before starting OAuth or entering a token. Provider
confirmation is required where OAuth applies. The Gateway then verifies the returned account
identity without fetching task content; the PWA shows that **exact verified account** and the
granted scopes for final confirmation before creating a persistent Space grant. A mismatched
account or scope returns to Review and cannot silently approve a different grant. An already
verified account may be shown at the first review, but any account or scope change still needs
final confirmation. Credential input, callback state, token exchange, refresh, and removal stay
outside the model and all Spaces' durable content. Persistent setup authorization is a connection
workflow transition in the authenticated PWA, **not** an ordinary Pending decision resolvable from
Chat. This preserves
[ADR-0019](0019-channel-neutral-pending-decisions.md) and issue #98: separately prepared L1 task
effects still use the exact-id Pending-decision authority, and a package install follows
[ADR-0032](0032-reviewed-extension-hub.md).

## Verification and continuation

Verification checks only the declared capability and account. For Gmail it may read account
identity/capability metadata but no messages, threads, history, Watch, or mailbox state, as
[ADR-0024](0024-pull-based-personal-mailbox.md) requires. For GitHub it may authenticate and
discover the reviewed MCP tools without reading repository content. Each check has a deadline,
bounded response, redacted Trace, and explicit failure. Unsupported OAuth scope, missing tool,
changed server schema, inaccessible execution host, or unavailable provider leaves the attempt
non-ready with a concrete recovery step.

The original accepted Chat turn pauses at a **pre-effect checkpoint** with the bounded job and
Space identity durably attached to the attempt. Once ready, the Gateway atomically claims that
continuation once, rechecks the Space grant and original scope, and resumes the Agent through
`AgentRunner` with the now-eligible tools. Readiness itself never calls a service's content API.
The original job may then perform one bounded read and produce a concise reply plus one validated
Surface in the initiating Space, with its matching Event through a recoverable Surface commit.
No other Space receives the result. If setup is cancelled or fails, the job remains unperformed and
Chat reports that state. If the Gateway crashes after resumed work begins, the existing
[Chat timeline](0029-gateway-owned-chat-timelines.md) rule applies: mark it Interrupted and require
an explicit retry; do not automatically replay a possibly effectful turn. A completed durable
outcome is replayed, not executed again. Reload and another authenticated device see the same
attempt and authoritative Chat timeline state.

Health is checked on explicit inspection and when a requested operation needs the connection;
background checks may verify authorization metadata but may not fetch service content. A failed
token refresh or tool discovery changes health and stops affected work. Reconnect goes through the
same protected PWA/provider path and preserves the stable connection id only when account identity
matches. Scope expansion requires new review. The user can restrict a Space's tools or resources,
disable its grant, disable the whole connection, or remove it. Disable/revoke blocks future calls
and Automation occurrences immediately; in-flight work is cancelled where possible and any
ambiguous external outcome is reported as unknown, never retried silently. Removing credentials
does not delete existing Space-owned Surfaces, Events, or user data. Every Space grant/restriction
change appends a safe Event to that Space; connection health and credentials remain Gateway-wide
state. An Automation stores the connection id and exact Space grant, rechecks them when due, and
records an unavailable outcome instead of borrowing a different Space's grant.

## Required user proofs

- **Gmail:** From a fresh Space ask for a bounded unread search. Review the account and minimum
  scopes in the PWA, complete OAuth, verify identity without message access, then resume the same
  request through issue #122. Confirm unread flags stay unchanged and only that Space receives the
  Mailbox Surface/Event. Repeat with cancel, denied OAuth, expired token, restart, and reconnect.
- **GitHub:** In another fresh Space ask for open issues in a disposable repository. Review the
  pinned GitHub MCP server, token permissions, tool names, and repository scope; enter a fine-grained
  token in the PWA, verify MCP discovery, then resume one `list_issues` call. Confirm the validated
  Surface/Event after refresh and Gateway restart. Revoke the token and observe `needs_reconnect`;
  a new Space cannot use the connection until explicitly granted. A separately approved issue
  creation proves the L1 path without making write access an implicit consequence of a read task.

The implementation owners are #181 for Gmail and #182 for reuse of this journey after #180's MCP
path. #121–#123 remain Mailbox-specific. #98 owns Chat resolution of true Pending decisions; #155
owns durable Chat continuation. Reusing a Model-connection form was rejected because Model
connections provide inference only, while service connections authorize external actions. A
per-Space credential was rejected because it would duplicate account identity and make revocation
inconsistent across Spaces.

Status: accepted
