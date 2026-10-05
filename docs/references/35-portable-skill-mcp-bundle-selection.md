# Research 35 — A released portable Skill and MCP bundle for #189

Checked on **2026-10-05** for [issue #189](https://github.com/Ic3b3rg/veduta/issues/189).
This selects an existing package for later implementation; it does not certify an installation.
The source archives were downloaded and inspected in memory. No third-party executable,
dependency installation, MCP process, imported Skill, or Veduta activation was run.
Two anonymous, public **direct API** reads were exercised separately below. No credentials,
private repository contents, or persistent test data were used.

## Selection and current disposition

Select **HiAI's `context7` Agent Plugin v0.0.2**, from the released
[`HiAi-gg/agent-plugins` collection v0.0.4](https://github.com/HiAi-gg/agent-plugins/releases/tag/v0.0.4),
at commit `f957d56106fb6b03d67dc832222c3e048167e80e`, package root `plugins/context7/`.
The package has a portable Agent Plugins **1.0.0** manifest, three Agent Skills, and a stdio
MCP definition pinned to **`@upstash/context7-mcp@3.2.5`**. HiAI authors the procedures;
Upstash authors the MCP dependency. They are distinct publishers. This is a pre-existing
released bundle, rather than a new example assembled for Veduta. [Manifest][manifest],
[MCP definition][mcp], [package tree][tree]

The recommendation is **Adaptation required**, with a concrete setup and proof plan. The format
is a suitable research target, but the package has not met Veduta's complete live verification
bar. Its authored launcher resolves transitive dependency ranges at installation time, the
publisher's Node requirement is stale, and the selected stdio/runtime/egress boundary needs its
own proof. An upstream `RUNTIME_VERIFIED` statement is upstream evidence only, not Veduta's
Verified status. [Publisher's runtime notes][build-notes],
[exact dependency manifest][server-package], [ADR-0032](../adr/0032-reviewed-extension-hub.md)

The existing [Research 26](26-external-skills-plugin-compatibility.md),
[27](27-popular-external-extension-proving-cases.md),
[28](28-extension-candidate-evidence.md), and
[30](30-published-extension-live-proof.md) establish format and foreign-host compatibility
constraints but do not select a portable Skill/MCP bundle. A search of `packages/` for
`Agent Plugins`, `agent-plugins.org`, `mcp.json`, `PLUGIN_ROOT`, `PLUGIN_DATA`, and `context7`
found no existing portable installer. The accepted MCP implementation is a reviewed GitHub
profile, not evidence that arbitrary MCP packages already work.
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md)

## Exact byte identities

The collection release was published on 2026-09-03. Its release tag and the plugin's own
`0.0.2` version are different identifiers; pin both the immutable source commit and observed
bytes. GitHub supplies a source archive rather than an uploaded standalone Context7 asset.
Only `plugins/context7/` is the selected package; the other collection plugins are not part of
its installation. [Release][release], [release metadata][release-api], [manifest][manifest]

| Artifact                         | Immutable locator and observed identity                                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection source archive        | [Commit-addressed tar.gz][source-archive]; 181,338 bytes; SHA-256 `87c41cdd3bebaa2eb5ec9ef1aee7054461d7ab0a3c3d1551e95aed4a0aeb1dc7`        |
| Complete Context7 source subtree | 15 regular files; normalized inventory SHA-256 `f2cfaf01b0dcb1774abe3c74cfc45de3ac325825f4c20bababacea269511074a`                           |
| Publisher-defined runtime subset | Seven regular files, 11,182 bytes; normalized inventory SHA-256 `704443982e0e44e31ac8fa02b50742f56a17c9f77c1e6d85a3ca4614355140eb`          |
| MCP dependency tarball           | [npm 3.2.5 tarball][server-archive]; 28,837 bytes; SHA-256 `eb801dc8b6f29b315481f131fbf5258a99292fbf3325b0ef2ca2a5ac524c93cb`               |
| MCP dependency inventory         | 14 regular files; normalized inventory SHA-256 `0dd65705ecf60ccbb1cb7523948767668b3bb73ca77adc4734981aa149836c18`                           |
| MCP entry point                  | `dist/index.js`, 25,560 bytes; SHA-256 `4000f1ce1ae2c240a6252c2c4af8720c80d26c234f371cc475ce4514d76d04b5`                                   |
| Upstream source tag              | `@upstash/context7-mcp@3.2.5` resolves to `b250c2515694eee4b6df4db82fa056df9ed3e306`; [tag reference][server-tag]                           |
| Upstream dependency lockfile     | [Commit-addressed `pnpm-lock.yaml`][server-lock]; 201,763 bytes; SHA-256 `014b45e2e629b2f1ed80a090fc8e080c4f837d7c560dc8917b19cf7ff2604e3a` |

These hashes are **measured by this research**, not publisher attestations. The npm tarball's
computed SHA-512 also matched the exact version's registry `dist.integrity`:
`sha512-m+GIwQKBx2yCnLN7Et3wqkuTk1iPkMySQH2i6KiUf4B9wVI0tgtjeXRcDfFZPf5rnRA3gjYhr1FqQqMb9aSRnw==`.
The registry metadata has no `gitHead`; the source tag exists independently, but a reproducible
source-to-compiled-artifact build has **not** been performed. A tag, digest, or registry signature
does not establish complete compatibility. [Exact npm metadata][registry]

Inventory normalization used a JSON array sorted by package-relative path. Each object has,
in order, `path`, `size`, and `sha256`; UTF-8 serialization uses `ensure_ascii=False`,
`separators=(',', ':')`, and no trailing newline. Hashes cover file bytes, not executable mode
or ownership. Both selected subtrees were checked for regular files, path traversal, and
symlink/hardlink entries without extracting or executing them. Activation still needs the
installer's own bounded archive validation and checked executable permissions.
[ADR-0032](../adr/0032-reviewed-extension-hub.md)

The publisher defines the runtime subset as `plugin.json`, `mcp.json`, `skills/`, `README.md`,
and `LICENSE`. Its remaining files are authoring/review material, not executable requirements.
Retain them in inspection evidence, without silently installing the Builder or Doctor tools.
[Installation boundary][readme]

| Runtime file                                    | Bytes | SHA-256                                                            |
| ----------------------------------------------- | ----: | ------------------------------------------------------------------ |
| `LICENSE`                                       | 1,061 | `75d698484a06eb3db3aa225c034bb434083ec3152e451af4a907839c97ec8473` |
| `README.md`                                     | 3,880 | `62da60b1fe9fa548ee66c04c695b2e1d03ed37acdcd7aaf6a5fe25c454886c70` |
| `mcp.json`                                      |   245 | `ee3434439a767bb0de8dc28bc59941a0783e0efddcbd35c65d928ff672f1b1fc` |
| `plugin.json`                                   |   626 | `bd23ae4cec897dacdaa9d1d0b56069b3f46177639e7f3e0d5f393ad977c137fc` |
| `skills/check-current-library-version/SKILL.md` | 1,673 | `3eea41d6ee2fca593f729601c98b42d14d3a94013bd2f830f6a61d7e80c13213` |
| `skills/research-library-docs/SKILL.md`         | 2,105 | `0cf5550f78a5bb4e3ddd01d968958bbb00609ce673f6b50fae540940826bbd41` |
| `skills/verify-api-usage/SKILL.md`              | 1,592 | `b47f8ace765514a99bfbb8ee4484c0769eeccece6ae2deee940794466d25f01d` |

The complete source subtree additionally contains `CHANGELOG.md`, `plugin.yml`,
`docs/{BUILDER_PROVENANCE,BUILD_NOTES,UPSTREAM_TRUST}.md`, and
`skills-src/context7/{check-current-library-version,research-library-docs,verify-api-usage}.md`.
The dependency tarball contains `LICENSE`, `README.md`, `package.json`, `dist/index.js`,
`dist/lib/{api,client-ip,constants,encryption,jwt,redis,sessionStore,types,utils}.js`, and
`dist/lib/auth/auth-prompt.js`. Those complete inventories were computed from the linked
archives; neither archive includes installed transitive dependencies.
[Source archive][source-archive], [npm archive][server-archive]

## Host, dependency, and access review

The authored MCP recipe is `npx -y @upstash/context7-mcp@3.2.5`, with explicit `type: stdio`.
It has no shell interpolation, client extension, foreign lifecycle hook, extra tool process,
or bundled application runtime. The manifest and MCP JSON parse successfully and declare the
same 1.0.0 schema. Their field shapes and the three Skill locations were inspected against
the standard; no full automated schema/conformance suite was run for this research.
[Manifest][manifest], [MCP definition][mcp], [portable specification][spec]

**Do not use the publisher's Node 18+ claim as the runtime requirement.** The exact npm
3.2.5 manifest requires **Node >=20.18.1**. Node, its executable digest, the package manager,
and all resolved dependencies must become part of the reviewed host profile.
[Publisher requirement][readme], [actual npm manifest][server-package]

The top-level MCP package is pinned, but its dependency versions use ranges. The upstream
lockfile provides a concrete candidate resolution for review:

| Runtime dependency          | Declared range | Upstream locked version   |
| --------------------------- | -------------- | ------------------------- |
| `@modelcontextprotocol/sdk` | `^1.29.0`      | `1.29.0` with `zod@4.4.3` |
| `@types/express`            | `^5.0.4`       | `5.0.5`                   |
| `@upstash/redis`            | `^1.38.0`      | `1.38.0`                  |
| `commander`                 | `^13.1.0`      | `13.1.0`                  |
| `express`                   | `^5.1.0`       | `5.1.0`                   |
| `jose`                      | `^6.2.3`       | `6.2.3`                   |
| `undici`                    | `^7.0.0`       | `7.28.0`                  |
| `zod`                       | `^4.4.3`       | `4.4.3`                   |

This table comes from the [source manifest][server-package] and
[source lockfile][server-lock]. It is not a completed review of the transitive closure,
maintainers, licenses, install scripts, or runtime engine constraints. That full review and
staging are required before execution. No command should resolve fresh dependencies during
activation or restart. A reviewed offline launcher may preserve the original manifest while
mapping its recipe to staged bytes, but that mapping and exact command must be visible in the
compatibility report. If the installer cannot enforce it, activation remains blocked.
This is an implementation recommendation under
[ADR-0032](../adr/0032-reviewed-extension-hub.md), not an already implemented launcher.

The bundle's license file is MIT, copyright HiAI. The dependency includes its own MIT license,
copyright Upstash. Keep both notices; do not infer transitive licenses from either top-level
license. HiAI's bundle is not an Upstash-authored package or an Upstash endorsement.
[Bundle license][bundle-license], [dependency license][server-license],
[publisher provenance][trust]

For the selected stdio profile, the inspected implementation issues public GET reads to
`https://context7.com/api/v2/libs/search` and `/api/v2/context`. It sends the library name/id
and natural-language query, plus MCP source/version, process-session id, client name/version,
and transport headers. Thus a query can disclose user content even without an API key.
Use invented/public questions; never forward private code or credentials. No user filesystem
mount is required for the server. [API implementation][api], [header implementation][headers]

Acquisition needs the approved GitHub/codeload and npm registry origins. **Runtime** egress
should allow only the reviewed Context7 API path/host, through an enforced destination boundary;
default `fetch` redirects are not a containment guarantee. Start with an empty inherited
environment: endpoint overrides, proxy variables, custom CA paths, Redis credentials, and
HTTP/OAuth settings are not implicit permission. The optional HTTP mode and its Redis-backed
session store are outside this stdio selection. [API implementation][api],
[runtime entry point][server-entry], [constants][constants],
[ADR-0032](../adr/0032-reviewed-extension-hub.md)

## Tools, complete Skill behavior, and auth profile

Only two tools are registered by the inspected entry point:

| Tool                 | Inputs                 | Reviewed task/effect                                                |
| -------------------- | ---------------------- | ------------------------------------------------------------------- |
| `resolve-library-id` | `libraryName`, `query` | Resolve candidate public documentation libraries and versions; read |
| `query-docs`         | `libraryId`, `query`   | Retrieve documentation for one selected library/topic; read         |

The package has no exposed remote write tool. Its annotations are useful review inputs, not
Veduta's effect authority. Its prompts/resources lists are empty; optional sign-in elicitation
is skipped when the client does not advertise that capability. Required behavior does not
appear to need sampling, roots, prompts, resources, or elicitation, but this remains a source
observation until tested with Veduta's exact negotiated protocol.
[Tool registration][server-entry], [optional auth prompting][auth-prompt],
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md)

| Included Skill                  | Complete advertised workflow and proof obligation                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research-library-docs`         | Identify the package/version, resolve and read focused documentation, extract relevant APIs/configuration/version caveats, and explain the applied facts and uncertainties. Verify a finite public question and retain cited evidence in a validated Space Surface. [Skill][research-skill]                                                                    |
| `verify-api-usage`              | Compare user-provided calls/options/imports to the relevant version's documentation, report correct/incorrect/uncertain usage and version drift, and avoid modifying code unless requested. Verify with an invented public snippet containing one intentional mismatch. [Skill][verify-skill]                                                                  |
| `check-current-library-version` | Compare a supplied pinned version with documented current stable/version changes, state the source's currency and uncertainty, and recommend without editing manifests or installing packages. Verify with a package whose published version evidence is actually present; indexed docs alone do not prove the latest registry release. [Skill][version-skill] |

The read proof is a Space-scoped request such as: “Research React Effect cleanup, show a cited
comparison of correct cleanup and a missing-cleanup example, and keep it in this Space.” The
Agent loads the included research Skill and calls the selected MCP tools, then produces the
normal validated Surface and matching Space Event. The other two Skills need separate finite
checks before claiming the **bundle's complete** behavior is verified. Code/files used in those
checks should be user-provided disposable input, not an implicit mount of the repository.
This is a proposed verification scenario grounded in the linked Skills and
[Surface contract](29-atom-conformance-matrix.md).

Select **anonymous stdio** as the initial auth profile. The original `mcp.json` requests no
secret. An optional `CONTEXT7_API_KEY` environment slot exists upstream, but its setup is an
additional reviewed profile, not permission conveyed by importing this bundle. Do not invoke
the separate `ctx7 setup` CLI, redirect credentials through Chat, or enable HTTP/OAuth merely
because upstream exposes them. [MCP definition][mcp], [stdio initialization][server-entry],
[auth prompting][auth-prompt]

Two #189 criteria need explicit resolution in its implementation brief: replace
“authenticated tool discovery” with discovery appropriate to the selected **no-auth** profile,
and replace unconditional “lost OAuth” with failed anonymous access/rate limits for this package.
If the maintainer instead requires an OAuth-capable first proof, choose a different package and
review a new transport/auth scope; do not silently add it here. The separately approved write
criterion is already conditional on package support and is **not applicable** to these two
read tools. No fake write should be invented to satisfy it.
[Issue #189](https://github.com/Ic3b3rg/veduta/issues/189), [runtime entry point][server-entry]

## Observed API proof and remaining failure/recovery proof

Direct GET probes on 2026-10-05 used no credential and only public React questions. They used
the same API paths and MCP source/version headers as the inspected server:

| Direct API probe                                                                    | Observed result                                                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Library search for `React`, query `React useEffect cleanup documentation`           | HTTP 200; 2,059 bytes; candidates included `/reactjs/react.dev`, `/react/react`, and `/websites/react_dev_reference` |
| Context for `/reactjs/react.dev`, query `React useEffect cleanup function behavior` | HTTP 200; 6,112 bytes; cleanup guidance and links to React's own source documentation                                |

These observations establish that an anonymous public API read worked at that time. They
**do not** exercise MCP initialization, tool schemas, dependency execution, Skill selection,
provider parity, Space grants, Surfaces, reload, or Gateway restart. They do not promote the
package to Verified. The response bytes stayed in memory and no persistent artifact was created.
[API paths and parameters][api]

The inspected API code catches failures and often returns an ordinary **text tool result**
instead of an MCP `isError` failure. Missing documentation, HTTP 401/404/429, provider errors,
and transport exceptions therefore cannot count as a successful readiness probe merely
because `tools/call` returned. Verification must recognize the reviewed failure forms, confirm
actual documentation/source evidence, and report uncertainty conservatively. The wrapper
must enforce deadlines, output bounds and cancellation; the server's fetch calls do not supply
their own abort signal or result-size cap. [API behavior][api], [tool result mapping][server-entry]

The following are **required future checks**, not observations from this research:

1. Missing/changed dependency bytes, unsupported Node, blocked acquisition, or failed bootstrap
   leave the bundle disabled with an exact error and safe retry/cleanup.
2. Unsupported manifest/MCP schema or transport, missing required tools, changed schemas,
   and attempted unselected calls never expose a partially ready bundle.
3. A clean-data browser flow exercises all three Skills, selected public MCP reads, the owning
   Space result, refresh, and restart with the same reviewed artifacts and grants.
4. Real anonymous rate-limit/provider failure and controlled malformed/oversized/timeout cases
   preserve truthful health. Cancellation terminates an unresponsive child. Controlled tests
   and real-service evidence must be reported separately.
5. Disable/revoke/remove stop future tool and Skill eligibility, terminate the process, remove
   staged package-owned data as approved, and preserve existing user-owned Surfaces. Restart
   cannot restore revoked grants. Optional API-key revocation needs a separate proof only if
   that expanded profile is explicitly approved.
6. Every eligible Model connection uses the same Veduta ToolDefs. No provider-native MCP,
   host-native hooks, second Agent loop, or generated HTML is needed.

These gates follow [#189](https://github.com/Ic3b3rg/veduta/issues/189),
[ADR-0032](../adr/0032-reviewed-extension-hub.md),
[ADR-0034](../adr/0034-veduta-owned-mcp-client.md), and
[Architecture](../../ARCHITECTURE.md). Inspecting bytes and a successful API call are
insufficient substitutes.

## Sequencing and decisions still needed

[Issue #177](https://github.com/Ic3b3rg/veduta/issues/177) and
[#179](https://github.com/Ic3b3rg/veduta/issues/179) are closed decision issues. #189 still
depends on [#183](https://github.com/Ic3b3rg/veduta/issues/183) and
[#180](https://github.com/Ic3b3rg/veduta/issues/180). On this check, #180 remains open:
its comments distinguish real read evidence from the outstanding disposable, separately
approved write and revocation/recovery journey. This research neither changes those states
nor closes #189. [Latest #180 evidence](https://github.com/Ic3b3rg/veduta/issues/180#issuecomment-5994253359)

Before implementation, record acceptance of the anonymous read-only proof profile and its two
criterion clarifications; inspect and freeze the dependency closure and launcher; identify
the exact enforced Gateway host/egress profile; and keep the source tag/compiled-artifact
provenance gap visible until reviewed. Linux activation remains the separate host proof in
[#196](https://github.com/Ic3b3rg/veduta/issues/196). These are concrete bounded tasks rather
than an unresolved search for a package. Public catalog distribution still requires human
Hub review under [ADR-0032](../adr/0032-reviewed-extension-hub.md).

[release]: https://github.com/HiAi-gg/agent-plugins/releases/tag/v0.0.4
[release-api]: https://api.github.com/repos/HiAi-gg/agent-plugins/releases/tags/v0.0.4
[tree]: https://github.com/HiAi-gg/agent-plugins/tree/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7
[manifest]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/plugin.json
[mcp]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/mcp.json
[readme]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/README.md
[build-notes]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/docs/BUILD_NOTES.md
[trust]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/docs/UPSTREAM_TRUST.md
[bundle-license]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/LICENSE
[source-archive]: https://codeload.github.com/HiAi-gg/agent-plugins/tar.gz/f957d56106fb6b03d67dc832222c3e048167e80e
[registry]: https://registry.npmjs.org/@upstash/context7-mcp/3.2.5
[server-archive]: https://registry.npmjs.org/@upstash/context7-mcp/-/context7-mcp-3.2.5.tgz
[server-tag]: https://github.com/upstash/context7/tree/b250c2515694eee4b6df4db82fa056df9ed3e306
[server-package]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/packages/mcp/package.json
[server-lock]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/pnpm-lock.yaml
[server-license]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/LICENSE
[server-entry]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/packages/mcp/src/index.ts
[api]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/packages/mcp/src/lib/api.ts
[headers]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/packages/mcp/src/lib/encryption.ts
[constants]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/packages/mcp/src/lib/constants.ts
[auth-prompt]: https://github.com/upstash/context7/blob/b250c2515694eee4b6df4db82fa056df9ed3e306/packages/mcp/src/lib/auth/auth-prompt.ts
[research-skill]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/skills/research-library-docs/SKILL.md
[verify-skill]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/skills/verify-api-usage/SKILL.md
[version-skill]: https://github.com/HiAi-gg/agent-plugins/blob/f957d56106fb6b03d67dc832222c3e048167e80e/plugins/context7/skills/check-current-library-version/SKILL.md
[spec]: https://agent-plugins.org/specification
