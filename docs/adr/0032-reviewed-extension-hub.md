# Reviewed external extensions and the public Veduta Hub

Issues #177 and #176 establish a post-v1 Hub whose first release includes a public catalog,
community submission, and human review **before** distribution. This decision changes the official
upstream support boundary of [ADR-0026](0026-skills-may-drive-general-tool-execution.md): v1 still
loads first-party Skills only; the later Hub may load an exact, reviewed external package after the
user approves its complete setup. It does not turn a downloaded package into product-owned policy.
The anti-requirements in [Architecture §7](../../ARCHITECTURE.md) still govern the v1 release.

## Package and compatibility contract

The Hub accepts four input classes: Agent Skills, Agent Plugins 1.0.0 Skills/MCP bundles, direct
MCP server definitions, and Veduta-native extension packages. The Agent Skills and Agent
Plugins formats retain their own conformance rules; Veduta's decision to activate a package is a
separate question. A bundle may parse successfully while installation remains blocked because a
component needed for its advertised behavior cannot run. Portable Skills are procedures, never
permissions. Their executable support files, if any, are dependencies requiring the same inspection
and approval as an executable package. Agent Plugins 1.0.0 client extensions for other hosts are
ignored for format parsing but shown as unmet requirements when advertised behavior depends on them.

Every inspected artifact is identified by source registry and publisher, version, immutable
SHA-256 of the downloaded bytes and normalized file inventory, and a review record. The
downloader rejects path traversal, links escaping the package root, size or file-count excess,
redirects to an unapproved origin, digest mismatch, and archive mutation between review and
activation. A catalog label or malware scan is evidence to inspect, never a working-behavior proof.
The compatibility report records source and maintainer provenance gaps, every file and executable
dependency, dependency source/version/maintainer/contents, host APIs, setup commands, data access,
network destinations, secret slots, execution host, license, and complete advertised behavior.
Unknown mandatory behavior blocks activation.

The status belongs to the **exact artifact and environment**, not a package name:

| Status              | Meaning and allowed next step                                                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified            | A reviewer reproduced every required behavior with disposable data through Veduta, including restart and a failure/recovery path; the same digest and compatible host profile may be offered for approval. A public badge requires a human Hub reviewer. |
| Adaptation required | A reviewed Veduta port or dependency substitution has a concrete plan, but some required behavior has no passing live proof. Preview only.                                                                                                               |
| Unsupported         | A required host API, execution location, transport, dependency, or behavior is unavailable. Preview names the missing part and a viable next step, if known.                                                                                             |
| Unsafe              | Provenance, permissions, behavior, or review cannot meet the Hub trust policy. No installation or enablement.                                                                                                                                            |

An imported package is never silently labelled Verified because its Markdown loaded, MCP discovery
succeeded, or one tool call worked. An adapted port receives a new Veduta artifact id and digest;
the listing links its exact foreign source and distinguishes the port from native compatibility.
The dated candidate review and explicit proof scenarios are in
[extension candidate evidence](../references/28-extension-candidate-evidence.md).
The [published-artifact live proof](../references/30-published-extension-live-proof.md) records
the exact Obsidian and self-improving-agent versions, disposable runtime results, dependency drift,
host-only behavior, and the remaining activation blockers. Neither package is verified in Veduta.

## Veduta-native host contract v1

`veduta-extension.json` declares semver `schemaVersion` and `version`, reverse-domain `id`,
`hostApi: { major, minMinor }`, entrypoint digest, component names, fixed JSON Schemas for tool
inputs and outputs, requested lifecycle events, effect class, network hosts, file mounts, and
secret slots. The first supported manifest schema is `1.0.0` and host API major is `1`. Unknown
required fields or a different major host API fail closed. Minor v1 additions are optional and
feature-negotiated; a package may declare a minimum minor version. The immutable review record
binds the manifest, executable, dependencies, and effective permissions. Updates never inherit an
old approval when any of these change.

The v1 manifest shape is closed at the top level. A representative search port is:

```json
{
  "schemaVersion": "1.0.0",
  "id": "org.veduta.ports.brave",
  "version": "1.0.0",
  "hostApi": { "major": 1, "minMinor": 0 },
  "entrypoint": { "path": "bin/brave-search", "sha256": "<64 hex digits>" },
  "tools": [{ "name": "web_search", "effect": "read", "inputSchema": {}, "outputSchema": {} }],
  "hooks": [],
  "permissions": {
    "networkHosts": ["api.search.brave.com"],
    "mounts": [],
    "secretSlots": ["brave_api_key"]
  }
}
```

Production manifests use valid bounded JSON Schema objects in place of the illustrative empty
schemas. `entrypoint.path` is package-relative and cannot escape the root; it is invoked directly
with reviewed fixed arguments and no shell. Tool names are unique inside the package and exposed
to the Agent as `<extension-id>/<tool-name>`. Effect is one of `read`, `write`, `destructive`, or
`credential`; reviewers may raise it, never lower it to satisfy a package request. A host API major
change requires a new accepted contract, while a minor addition cannot change an existing field's
meaning. Secret slots are opaque names until an authenticated user binds a vault reference during
setup. The entrypoint cannot select extra tools, hooks, mounts, hosts, or secrets at runtime.

The Gateway starts reviewed executable code as a separate, supervised process and communicates
over a versioned JSON-RPC interface: `extension/initialize`, `tool/call`, `hook/run`, and
`extension/shutdown`. Tool registration is the reviewed manifest set, not arbitrary runtime code.
The host validates each call and bounded result, applies deadlines and cancellation, and wraps
approved tools as Veduta `ToolDef`s through `AgentRunner`. No extension imports `pi-agent-core`,
owns an Agent loop, mutates a Surface directly, or emits generated HTML. Its output is Untrusted;
the Agent's durable result still goes through protocol-validated Surface authoring and the owning
Space's Event log.

`extension/initialize` receives host API version, package identity, and an opaque grant reference;
it returns a compatible version and readiness diagnostics, not new capabilities. `tool/call`
receives a call id, reviewed tool name, validated arguments, and grant reference; its bounded
structured/text result is checked against the declared output schema. `hook/run` receives an
invocation id, one declared event, grant reference, and the event's bounded payload. A hook may
return a context contribution, learning candidate, or Character-change proposal within its
declared output type; the Gateway owns any resulting mutation or Pending decision.
`extension/shutdown` is best effort. The host may terminate a stalled process, and a terminated
process cannot claim that a remote effect was rolled back.

The first host API offers Agent tools and two opt-in lifecycle events: `beforeContextAssembly`
(bounded, Space-scoped context contribution) and `afterTurnSettled` (bounded outcome plus redacted,
structured error, user-correction, and capability-gap summaries after a turn). The latter signals
are prepared by Veduta with user opt-in; the extension cannot request a transcript or expand the
summary. A self-improving port may use them to capture a learning candidate, deduplicate it in
its scoped data, and offer a next-turn reminder through `beforeContextAssembly`. This is a proposed
replacement for the foreign bootstrap and session-end hooks, not proof of parity: if disposable
tests cannot reproduce automatic error, correction, and feature-request capture plus reviewed
promotion, that port remains Unsupported. Hooks cannot read raw Chat timelines, Agent sessions,
other Spaces, the secrets vault, or write SOUL/INSTRUCTIONS directly. A proposed Character change
uses the existing diff and Pending-decision authority. Hook effects use the same reviewed
permission record as tools; an absent event is never emulated by silently executing foreign
hooks. External event sources, messenger Bridges, Model providers, arbitrary OpenClaw/Hermes API
callbacks, and provider-native rich Surface projections are outside host API v1. A later Bridge follows
[ADR-0028](0028-concrete-bridge-extension-seam.md), not this tool interface.

Foreign-native packages are **ported** to this API only after their complete required behavior is
tested. The OpenClaw Brave provider can become a Veduta search tool; its OpenClaw registration and
config API are not loaded. Hermes Web Search Plus can become two tools plus the reviewed start
hook; Python `register(ctx)` is not a Veduta ABI. The self-improving-agent's OpenClaw
`agent:bootstrap` and `command:new/reset` hooks have no direct equivalent: a Veduta port must
prove the same reminder, learning capture, and reviewed promotion using the available lifecycle
events or stay Unsupported. Direct execution of those foreign hooks is blocked.

## Execution and authority

Reviewed native code and bundled MCP subprocesses run on the **Gateway host** inside an isolated
process/container boundary with a dedicated identity, immutable package mount, separate writable
package data, an empty inherited environment, and explicit read/write mounts. An egress proxy or
host firewall limits them to approved network destinations. The installer verifies that the
selected VPS or Local VPS profile can enforce every requested process control before activation;
otherwise executable activation is Unsupported. A requested Mac-local vault on a VPS is
unavailable until the user explicitly supplies a mounted or synchronized path reachable by the
Gateway; the PWA's browser access to that vault proves nothing about Gateway access. The installer
probes the chosen path and exact dependency commands using disposable data before reporting ready.
Loopback remains a development profile, not the Hub's security proof.

The Gateway stores credentials outside model context and grants a process only the reviewed secret
slot needed for a call. A package never gets the whole vault. Per-Space activation identifies the
Gateway-wide installation, allowed tools/hooks, resource scope, and owning Space. Revocation stops
new calls and hooks, cancels or explicitly settles in-flight work, and records safe Space-owned
provenance. No installed package sees another Space's results by default. For a typed host tool,
read-only operations may run within the approved scope, outbound writes require a prepared L1
Approval card, and destructive or credential-management operations are L2. A reviewer sets the
effect class; a package's self-reported annotation does not. A post-approval remote effect whose
outcome is uncertain after a crash is not retried automatically.

This process boundary limits files, destinations, and secret exposure; it does not prove the
semantic effect of arbitrary code at an approved destination. External text Skills may teach the
Agent to use the broad general execution tool from ADR-0026. For those calls, effect discipline is
the official Skill and Agent policy plus Trace and review, not a universal command sandbox. A
reviewer must reject a package whose requested authority cannot be made honest under that limit.

## User and public lifecycle

A ClawHub or Hub link pasted in Chat starts **inspection only**. The user sees the pinned package,
compatibility report, exact dependency and setup plan, Gateway execution host, requested
permissions, and expected live proof. The authenticated PWA handles secret entry, package and
dependency approval, and provider consent. A workflow-owned Pending decision carries any
prepared effect approval; its exact identity and outcome use
[ADR-0019](0019-channel-neutral-pending-decisions.md) and issue #98. Approval of a package is
separate from a later L1 task approval. Installation stages bytes and dependencies without
activation; only a successful disposable live verification makes the approved Space scope ready.
Failure leaves a disabled, diagnosable attempt with cleanup/retry options, never a partial success.
An external link may lead to a **private local import** of a supported portable package after this
review and approval. It is labelled locally verified only after its complete live proof and is
never distributed from the public catalog by that route. A foreign-native module still requires
a Veduta port; local approval cannot make its original host API run. Public distribution requires
the separate human Hub review below.

Installed versions are immutable. Update review shows the file, dependency, permission, and
behavior diff; activation is atomic with rollback to the last working version. Disable immediately
removes future tool and hook exposure. Removal revokes secret references and package-owned state
after the user chooses what to retain; it never deletes user-owned Surfaces or files silently.
Revocation and emergency disablement invalidate running grants, including after restart. Trace
records bounded redacted execution; the installation/reviewer record and Space Event log, not
Trace, own provenance.

The public Hub accepts a contributor's immutable artifact, manifest, source and dependency
provenance, permission inventory, license, reproducible disposable test recipe, and compatibility
evidence. A human reviewer records identity, tested digest/host, observations, failures, and an
approve/reject decision. Only approved exact versions appear as installable catalog entries. A
new version is a new review; a takedown hides distribution but retains the audit record; an
emergency block prevents new activation and disables the affected digest on the next verified
catalog-policy check, with an offline warning instead of pretending revocation was received.
Publisher and reviewer roles are distinct for a public submission. Reviewers reproduce the
declared task, restart, and failure recovery before publication.
The Hub signs versioned catalog and emergency-block records with a key trusted by the Gateway;
key rotation follows a signed Veduta release. New public installs require a fresh verified record.
An offline Gateway retains its last verified policy, warns that revocation freshness is unknown,
and cannot claim to have received a new emergency block.

Chat can guide creation of a draft Skill, MCP bundle, or Veduta-native process package with
manifest, tests, setup recipe, and proposed listing. The user reviews the complete local artifact,
then explicitly approves a disposable test and any local activation. Submission enters the same
human queue; neither generation nor submission publishes or enables code automatically. The
implementation slices and release proof already have owners in issues #183–#193.

## Sources and alternatives

[Agent Skills](https://agentskills.io/specification) defines the Skill document;
[Agent Plugins 1.0.0](https://agent-plugins.org/specification) defines the portable Skills/MCP
package floor and leaves native host extensions client-specific. Direct foreign module loading
was rejected because shared language or package format is not host API compatibility. Treating a
scan, import, or partial tool call as readiness was rejected because it would advertise missing
behavior as working.

Status: accepted
