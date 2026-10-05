# Gog: advertised function matrix and implementation gates

Research observed on **2026-10-05** for [issue #184][issue184]. This is source and
package inspection, **not live compatibility proof**. No Google account, credential,
OAuth flow, installed CLI, or Veduta task was used. Public archives were hashed and
inspected in memory; their executables were neither extracted nor run.

The original `@steipete/gog` requires **six services and fourteen function proofs**:
Gmail 2, Calendar 2, Drive 1, Contacts 1, Sheets 5, and Docs 3. Eight functions read
remote data; six cause remote writes, including destructive Sheets clearing. The
twelve concrete common-command examples in the published Skill are supplemented
by its explicit Docs-copy claim and Calendar-create instruction. Setup and output
variants are additional gates, not extra service functions. All fourteen live
proofs remain **unverified**. A Calendar-only port must have a separate Veduta
identity and narrow listing; it cannot satisfy original Gog readiness or the full
Gog requirement in [issue #193][issue193]. [Published Skill][skill], [issue #184][issue184]

## Canonical requirements and dependency state

The specifications read were #184, #183, #181, #123, and #177, including their
comments. #184 currently depends on the open issues #183, #181, and #123. Research
and work breakdown can proceed, but dependent implementation must respect
[the issue-tracker contract](../agents/issue-tracker.md). #177 is the completed
decision, not evidence that Gog works. Existing native Gmail read evidence in the
[latest #181 audit][connection-audit] does not prove an external Gog process's
account selection, granted scopes, keyring access, output handling, or lifecycle.
[Issue #183][issue183], [issue #181][issue181], [issue #123][issue123], [issue #177][issue177]

This note extends the existing [compatibility research](26-external-skills-plugin-compatibility.md),
[proving cases](27-popular-external-extension-proving-cases.md),
[candidate evidence](28-extension-candidate-evidence.md),
[Atom conformance matrix](29-atom-conformance-matrix.md), and
[published-package proof](30-published-extension-live-proof.md). It follows
[CONTEXT.md](../../CONTEXT.md), [ARCHITECTURE.md](../../ARCHITECTURE.md),
[ADR-0024](../adr/0024-pull-based-personal-mailbox.md),
[ADR-0026](../adr/0026-skills-may-drive-general-tool-execution.md),
[ADR-0032](../adr/0032-reviewed-extension-hub.md),
[ADR-0033](../adr/0033-chat-initiated-service-connections.md), and
[the security model](../SECURITY.md). In particular, a Skill is a procedure, not
permission; package approval, Service connection, Space capability grant, and
individual effect approval remain separate authorities.

## Exact published package

The owner-qualified catalog and version endpoints report `steipete`, display name
Peter Steinberger, slug `gog`, version `1.0.0`, published at
`2026-01-04T16:49:06.060Z`. The Skill points to `https://gogcli.sh`, requires the
`gog` executable, and contains a foreign `clawdbot` Homebrew installation
descriptor. It contains no Veduta-native manifest or MCP server definition.
[Catalog metadata][catalog], [version manifest][manifest], [published Skill][skill]

The exact downloaded ZIP was **2,264 bytes**, with measured SHA-256
`f3d7459428f9204a5437fd62340b3da36534bcf975f2f08f8083bcae287fe63a`.
Every entry is listed below. The two Markdown hashes match the version manifest;
the generated metadata is an additional downloaded file absent from that
manifest. These are observed byte hashes, not a claim that a future response from
the same URL will have identical ZIP bytes. [Versioned download][download], [version manifest][manifest]

| Downloaded file | Bytes | Measured SHA-256                                                   | Role                                                              |
| --------------- | ----: | ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `SKILL.md`      | 1,748 | `00c1af6cde01299753439088916cb6e245ce00e1672b8cd4305a66d7eac2abad` | Procedure, setup descriptor, common commands, and operating notes |
| `skill-card.md` | 1,788 | `b26493c7a5001537544eb8dca2bccce7bbd00b52d853b9f2ef8718d29d383a95` | Generated permissions/risk summary; not executable proof          |
| `_meta.json`    |   122 | `cc6641f746e2ad6348328f8f8f4bae6abdafb2245bc9e9a9e7d7bfd0e91752e5` | Registry-generated slug/version/publication metadata              |

There are no executable support files, hooks, install scripts, or license files
in these bytes. The `install` descriptor still proposes dependency installation;
Markdown-only packaging does not make activation dependency-free. The version's
license field is null and the card's license/terms field supplies no license.
The CLI's MIT license below does not establish a license for these Skill bytes.
Human review must resolve package licensing before public redistribution.
[Version manifest][manifest], [published card][card], [versioned download][download]

The catalog's current `owner.userId` is
`s179zksw999xz8ms4cy7pb2fr183m5jq`; downloaded `_meta.json` uses `ownerId`
`kn70pywhg0fyz996kpa8xj89s57yhv26`. The public responses examined do not explain
the mapping. This is an opaque provenance gap to record and reconcile, not proof
of malicious ownership. Likewise, the registry's clean scan has warnings and
reports identifier `f2917d0e1129a3c9442664669b3a4b6e92639a343eedaa266ffe4f896d00f3e5`,
different from the measured ZIP hash. No assertion is made that this scanner
identifier attests these exact ZIP bytes. A clean label cannot replace complete
inventory, permission review, or live proof. [Catalog metadata][catalog], [version manifest][manifest], [versioned download][download]

## Maintained dependency pin and source drift

The maintained CLI is [`openclaw/gogcli`][cli-repo]. The latest release observed
was **v0.43.0**, published `2026-10-01T03:52:48Z`. Its annotated tag resolves to
commit **`3b5122f4c81c5df6df38ee48e01327f1034364ee`**; GitHub reports the tag
unsigned. The later observed `main` commit was
`414e2ff8afa281ec3d9f0cdb057bdbc53386db91`; it is not the release source pin.
All CLI source links in this note use the release commit. [Release][release], [tag reference][tag-ref], [tag object][tag-object]

Two relevant binary archives were independently downloaded and measured. Each
contains a directory and one executable named `gog`; there are no bundled
dependency installers. Matching release digests establishes byte identity, not
source-to-binary reproducibility, execution success, or platform compatibility.
[Linux release archive][linux-archive], [macOS release archive][mac-archive], [release][release]

| Host candidate | Archive bytes | Measured archive SHA-256                                           | Executable bytes | Measured executable SHA-256                                        |
| -------------- | ------------: | ------------------------------------------------------------------ | ---------------: | ------------------------------------------------------------------ |
| Linux amd64    |    14,820,807 | `a16d4b8b917e36b96b09b30ecb7a5049d06ff1e88b856a101eec12b86b33fe05` |       44,646,560 | `f455948670f8ae9b1f60250e9a6407cb92fb90382ef040cc70c73742cb0afa5f` |
| macOS arm64    |    13,624,865 | `e93c2aef60b9a5c14f8f320c9554ed86776920a49afc51b684635aec2f5ca050` |       41,067,056 | `04a30b4a247a9ec127df0c1729640a14989c6c7a346240edb332fe42c373c7ec` |

The source module is `github.com/openclaw/gogcli`, licensed MIT, with a Go
`1.26.0` module declaration and `1.27.1` toolchain declaration. Its `go.mod` and
`go.sum` define the source dependency set, including the Google API/OAuth clients
and keyring support. Release configuration builds Linux without CGO and macOS
with CGO; source installation therefore has a different reviewed dependency and
toolchain footprint from installing the pinned binary. No Go, Homebrew, or CLI
installation was attempted. [Module][go-module], [dependency checksums][go-sum], [CLI license][cli-license], [release configuration][release-config]

| Published claim/recipe                                | Observed v0.43.0 evidence                                                                                                                                                                                                                                                                                                            | Consequence for review                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `steipete/tap/gogcli`                                 | Current maintained formula is `openclaw/tap/gogcli`, pinned at tap commit `c38bffe27ebef0e97c55cfdad55b13355eab5f33`. The old tap has no Gog formula at observed commit `5e25446e644a16bcd7ad56aeb945f7902c8a67c3`, but explicitly migrates `gogcli` to `openclaw/tap`. [Formula][brew-formula], [old tap migration][brew-migration] | Stale installation provenance; not demonstrated installation failure. Use the reviewed canonical dependency, then prove installation/version in the actual Gateway process profile. |
| `gog auth credentials <path>`                         | Current README prefers `gog auth credentials set <path>`, but the parser marks `set` as the argument-default command; a pinned upstream test still exercises the shorthand. [Credential command][credentials-source], [credential test][credentials-test], [README][cli-readme]                                                      | Documentation drift, **not a proven broken command**. Neither form is an Agent-facing plaintext credential recipe; protected setup must own this work.                              |
| Six services in one `auth add` call                   | Unqualified modes request broad Gmail settings, Calendar, Drive, Contacts/directory, Sheets, and Docs access. Newer upstream defaults also contain many other services if `--services` is omitted. [Scope generator][scope-source], [auth-add command][auth-add-source]                                                              | Explicit reviewed service list and exact scope diff are mandatory. Do not copy the broad setup as the default consent request.                                                      |
| Docs has no in-place edits                            | Current Docs command group includes editing commands beyond export/cat/copy. [Docs command group][docs-source]                                                                                                                                                                                                                       | The old negative claim is stale. Newly available writes are not automatically advertised requirements or authorized capabilities.                                                   |
| `GOG_ACCOUNT` and CLI keyring make scripts convenient | Dedicated-home configuration, environment overrides, and legacy fallback paths exist; headless file-keyring use needs a password supplied outside command text. [Path contract][paths-doc], [installation guide][install-doc]                                                                                                        | Bind a reviewed account/client and protected data root explicitly. A successful login shell is not evidence that the Gateway can reach the same keyring safely.                     |
| `--json` and `--no-input` support automation          | These are current options, but errors, partial output, output size, and post-write uncertainty still matter. [Automation guide][automation-doc]                                                                                                                                                                                      | Require zero exit, no truncation/timeout, validated output, and verified provider effect; never retry uncertain writes automatically.                                               |

## Service scope matrix

Scope names below omit the common prefix
`https://www.googleapis.com/auth/`; identity consent additionally needs the
reviewed `openid`, `email`, and `userinfo.email` scopes used by the CLI. The
second column is Google's documented scope support for the specific API
operation, **not a tested replacement OAuth recipe**. The third column is the
actual pinned CLI's service-level scope generator. They are not equivalent.
[Scope generator][scope-source]

| Service and original functions   | Smallest relevant API scope candidate                                                                                                                                                                                                        | Stock v0.43.0 request behavior and remaining limit                                                                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gmail search                     | `gmail.readonly`; `gmail.metadata` cannot serve the advertised query. [Threads list][gmail-list-api]                                                                                                                                         | `--gmail-scope readonly` or read-only mode requests `gmail.readonly`. Default Gmail requests `gmail.modify` and both settings scopes, which are unnecessary for search/send.                                                                                     |
| Gmail send                       | `gmail.send`; combining original search and send can use `gmail.readonly` + `gmail.send`. [Messages send][gmail-send-api]                                                                                                                    | `--gmail-scope send` and `read-send` exist. Read-only mode is incompatible with these send modes. A mail recipient scope and task approval are still required.                                                                                                   |
| Calendar events and create       | `calendar.events.readonly` for event reads; `calendar.events` for arbitrary accessible calendar writes, or `calendar.events.owned` when limited to owned calendars. [Events list][calendar-list-api], [event insertion][calendar-insert-api] | Calendar service requests `calendar.readonly` or full `calendar`. CLI selector/timezone helpers can read calendar metadata; narrower event-only scopes need actual command-path proof. Never claim an event-only recipe works from endpoint documentation alone. |
| Drive search                     | `drive.metadata.readonly` for metadata listing/search, subject to the actual query's needs; `drive.file` only for provider-authorized app files. [Files list][drive-list-api], [Drive authorization][drive-auth-doc]                         | Drive service supports full, read-only, or file mode; it has no metadata-only mode. Published generic search must not silently become a search of all owner files.                                                                                               |
| Contacts list                    | `contacts.readonly`. [Connections list][contacts-list-api]                                                                                                                                                                                   | Read-only Contacts also includes `contacts.other.readonly` and `directory.readonly`; default includes writable `contacts`. Those extra scopes are not required by the advertised connections-list endpoint.                                                      |
| Sheets get and metadata          | `spreadsheets.readonly`, or conditional `drive.file` for authorized app files. [Values get][sheets-get-api], [Spreadsheet metadata][sheets-metadata-api]                                                                                     | Read-only Sheets requests `spreadsheets.readonly` **and** `drive.readonly`; original get/metadata paths use Sheets API, not Drive export.                                                                                                                        |
| Sheets update, append, and clear | `spreadsheets`, or conditional `drive.file` for authorized app files. [Values update][sheets-update-api], [values append][sheets-append-api], [values clear][sheets-clear-api]                                                               | Sheets service requests `spreadsheets` plus the selected Drive scope. Selecting Drive file mode does not remove the broader Sheets scope. Clear also requires the L2 decision described below.                                                                   |
| Docs cat                         | `documents.readonly`, with `drive.readonly` or conditional `drive.file` also accepted. [Document get][docs-get-api]                                                                                                                          | Docs service requests both Docs and Drive scopes; read-only mode requests both read-only scopes. Cat uses the Docs API.                                                                                                                                          |
| Docs export                      | `drive.readonly`, or conditional `drive.file` for authorized app files. [Files export][drive-export-api]                                                                                                                                     | Export first checks file metadata and exports through Drive. The original text export does not need writable Docs access.                                                                                                                                        |
| Docs copy                        | Conditional `drive.file` for an app-authorized source/destination, otherwise reviewed broader Drive access. [Files copy][drive-copy-api], [Drive authorization][drive-auth-doc]                                                              | Copy uses Drive. Docs service requests writable `documents` as well as a Drive scope even though this operation needs no Docs edit call. Read-only consent cannot authorize copying.                                                                             |

`drive.file` is provider access to app-created, app-opened, or explicitly
user-selected files; a pasted file ID, a folder name, or a Space grant does not
create that Google permission. Google service scopes also do not structurally
restrict a broad process token to a single calendar, recipient, folder, sheet, or
document. The reviewed resource scope remains required and must be tested with
negative fixtures. [Drive authorization][drive-auth-doc], [ADR-0032](../adr/0032-reviewed-extension-hub.md)

The stock CLI's `--extra-scopes` adds scopes; it cannot subtract bundled service
scopes. Its auth-add code requires service selection and records requested scopes
with the token. Those records alone are not evidence of the provider's actual
grant. First determine whether the stock requests can be honestly approved; if
not, a separately reviewed upstream change or Veduta adaptation is required.
No narrower OAuth implementation is claimed here. Show the actual granted
account/scopes in the protected PWA flow before applying the Space capability
grant, as required by ADR-0033. [Scope generator][scope-source], [auth-add command][auth-add-source], [ADR-0033](../adr/0033-chat-initiated-service-connections.md)

## Function and disposable proof matrix

Every row is **source-supported, live-unverified**. The command references are
pinned v0.43.0 documentation/source; the required function inventory comes from
the exact published Skill. Proof starts with an explicit PWA Chat request and
ends in a protocol-validated, useful Space result, with refresh/reconnect checked.
The CLI command is implementation evidence, not a terminal-only manual QA plan.
Use a dedicated authorized test account and uniquely marked disposable provider
data, never incidental owner data. [Published Skill][skill], [issue #184][issue184]

| ID  | Required function / command family                                                                                                                          | Effect and approval                                                                                                   | Required disposable proof through Veduta                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Gmail thread search, `gog gmail search`; published recent query and `--max 10`. [Command][cmd-gmail-search], [implementation][gmail-search-source]          | Read; approved Mailbox and direct task. Preserve unread state.                                                        | Seed marked recent messages and an unread message in the test mailbox. Ask Chat for the matching recent mail. Verify IDs/count, bounded summary, and no unread change in provider UI; test empty results and an injected instruction. No raw mail or unrelated account data persists.                                               |
| G2  | Gmail send, `gog gmail send`, with recipient, subject, and body. [Command][cmd-gmail-send]                                                                  | Outbound write; prepared editable L1 Approval card.                                                                   | Send a unique message only to a controlled test recipient after exact approval. Verify one received message and one sent message with matching recipient/body. Denied, changed, expired, or replayed approval sends nothing; reconnect does not duplicate delivery.                                                                 |
| C1  | Calendar events, `gog calendar events`, explicit calendar and bounded time window. [Command][cmd-calendar-events], [implementation][calendar-events-source] | Read; approved account/calendar and direct task.                                                                      | Create marked in-window and out-of-window fixtures in a disposable calendar. Ask Chat for that calendar's date range; inspect the resulting Calendar Surface, timezone, event IDs, and exclusion of other calendars. Empty/forbidden calendar results must remain truthful after refresh.                                           |
| C2  | Calendar event creation, `gog calendar create`, required by the published confirmation instruction and #184. [Command][cmd-calendar-create]                 | Remote write; separate L1 Approval card.                                                                              | Prepare title/start/end/calendar in Chat; approve the exact event. Verify one provider event and the Space result. Use no attendees and `--send-updates none` for this fixture. Denial, wrong account, reconnect, or an uncertain post-send outcome must not create an automatic retry.                                             |
| D1  | Drive search, `gog drive search`, published `--max 10`. [Command][cmd-drive-search]                                                                         | Read; approved account/resource scope.                                                                                | Seed marked matching and nonmatching files plus a forbidden resource fixture. Ask Chat for matching files; verify names/IDs/links and bounds. Prove excluded resources cannot be surfaced through the reviewed scope, including shared-drive behavior. No implicit upload, share, move, or deletion is authorized.                  |
| P1  | Contacts listing, `gog contacts list`, published `--max 20`. [Command][cmd-contacts-list], [implementation][contacts-source]                                | Read; approved Contacts scope.                                                                                        | Create marked test contacts and ask Chat to list them. Verify identities/fields/count and empty/missing-scope behavior. Prove other-contact/directory access is not exercised merely because stock OAuth bundled those scopes.                                                                                                      |
| S1  | Sheets values read, `gog sheets get`, explicit `Tab!A1:D10`, JSON output. [Command][cmd-sheets-get]                                                         | Read; approved sheet and range.                                                                                       | Put unique values and an injected instruction in a disposable sheet, with sentinel values outside the requested range. Ask Chat for the range; verify cell coordinates/types and validated bounded presentation, without following the cell instruction or exposing another sheet.                                                  |
| S2  | Sheets metadata, `gog sheets metadata`, JSON output. [Command][cmd-sheets-metadata]                                                                         | Read; approved sheet.                                                                                                 | Use a disposable spreadsheet with named tabs and known dimensions. Ask Chat for its structure; verify spreadsheet/tab IDs, title and dimensions, and absence of unnecessary grid data. Bad IDs and denied access must not produce a ready result.                                                                                   |
| S3  | Sheets update, `gog sheets update`, JSON values and `USER_ENTERED`. [Command][cmd-sheets-update], [implementation][sheets-source]                           | Remote write; L1 Approval card showing exact sheet/range/values.                                                      | Approve a marked two-by-two update. Verify resulting strings/numbers/formulas as interpreted by `USER_ENTERED`, reported updated range, and untouched sentinel cells. Repeat the published inline-row variant as a separately controlled input case; denial/malformed values must not write.                                        |
| S4  | Sheets append, `gog sheets append`, JSON values and `INSERT_ROWS`. [Command][cmd-sheets-append], [implementation][sheets-source]                            | Remote write; L1 Approval card showing the rows and insertion behavior.                                               | Approve one marked row in a disposable table. Verify its actual appended range and one occurrence, including insertion behavior. Simulate interruption after provider acceptance; reconnect must inspect/report uncertainty rather than append a duplicate.                                                                         |
| S5  | Sheets clear, `gog sheets clear`, published bounded range. [Command][cmd-sheets-clear], [implementation][sheets-source]                                     | **Destructive, L2 under ADR-0032; permitted explicit user path unresolved.** No Agent-issued broad execution command. | Once the L2 path is settled, clear only a marked disposable range through that path; verify removed values and preserved neighboring cells/formatting. Denial and a broader-range request cause no clearing. Original Gog remains blocked until this function has both an allowed execution path and passing proof.                 |
| T1  | Docs text export, `gog docs export`, `--format txt` and explicit output path. [Command][cmd-docs-export], [implementation][export-source]                   | Remote read plus local file creation; approved document and bounded writable package-data mount.                      | Export a small marked test document into a dedicated temporary package-data directory. Verify text and file byte count, then produce the useful Space result through bounded readback. The CLI's JSON path report alone is insufficient. Prove forbidden paths/overwrite attempts fail, and remove the disposable export file.      |
| T2  | Docs text read, `gog docs cat`. [Command][cmd-docs-cat], [implementation][docs-read-source]                                                                 | Read; approved document.                                                                                              | Ask Chat for a short marked document. Verify exact relevant text, bounded Untrusted handling and a schema-validated result. Also exercise a document larger than the chosen command/output bound and an injected instruction; truncation must not be reported as complete.                                                          |
| T3  | Docs copy, `gog docs copy`, the explicit third Docs claim. [Command][cmd-docs-copy], [implementation][docs-source]                                          | Remote write through Drive; L1 Approval card identifying source, title, and destination.                              | Approve a copy of a disposable document into an approved test folder. Verify new ID/content/title/parent, preserved original, and one copy after reconnect. Missing Drive write grant, forbidden destination, or denial produces no copy. New upstream in-place editing commands remain outside the original reviewed function set. |

Sheets clearing is a material product-policy gate, not a missing CLI command.
Pinned source calls `Values.Clear` without a built-in effect Approval card.
ADR-0032 classifies destructive effects as L2, and the security model prohibits
official Skills performing L2 commands through broad general execution. A
permitted explicit user operation under the existing L2 contract, or a separately
accepted decision resolving the conflict, is needed before implementation can
claim this part of original Gog. Credential setup has the same protected-flow
requirement. This research does not silently lower either effect's class.
[Sheets implementation][sheets-source], [ADR-0032](../adr/0032-reviewed-extension-hub.md), [security model](../SECURITY.md)

The generated card also warns generally about changing or clearing Drive
content. It does not enumerate an additional mandatory Drive mutation. The
inventory above includes the explicit Docs-copy Drive write, but does not invent
an obligation to expose every current upstream upload/delete/edit command.
If review concludes that any additional card statement is a required advertised
function, enumerate and prove it before readiness; unknown mandatory behavior
blocks activation. [Published card][card], [ADR-0032](../adr/0032-reviewed-extension-hub.md)

## Setup, output, and lifecycle proof gates

These gates are additional to the fourteen function rows. Their implementation
is planned, and none was exercised here.

1. **Inspection and installation identity.** Start from the ClawHub link in Chat;
   show all downloaded files, hashes, generated metadata, provenance/licensing
   gaps, dependency version/contents, execution host, protected mounts, network
   destinations, secret slots, requested scopes, and proof plan before installing
   anything. A changed artifact, unavailable dependency, wrong architecture,
   unsupported host isolation, failed install, or unknown required behavior
   leaves a disabled, diagnosable attempt. Reuse #183's general inspection path.
   [Issue #183][issue183], [ADR-0032](../adr/0032-reviewed-extension-hub.md)
2. **Protected Service connection.** OAuth client configuration, authorization
   code, refresh token, and keyring password never pass through Chat, Agent
   context, command text, Trace, Events, or plaintext backups. Use the existing
   PWA/provider Connection attempt lifecycle, show the verified identity and
   actual granted scopes, then complete the exact Space capability grant. Setup
   identity verification is not a sample content read. The advertised credential
   import, auth-add, and auth-list behaviors must work through this protected
   integration rather than an Agent's pasted setup command. [Credential command][credentials-source], [auth-add command][auth-add-source], [ADR-0033](../adr/0033-chat-initiated-service-connections.md)
3. **Gateway process and credential ownership.** Prove the pinned binary/version,
   selected account/client, dedicated home/data root, keyring, minimal environment,
   and writable mounts in the actual Gateway profile, including service restart.
   The current general execution runner passes only `PATH`, `HOME`, and `LANG`;
   it does not inherit `GOG_KEYRING_PASSWORD`. Putting that password in a command
   is forbidden. Its inherited `HOME` can also expose ambient CLI configuration.
   A safe keyring mechanism or reviewed protected execution-resource support is
   therefore an implementation prerequisite, not a shell workaround.
   [General execution source](../../packages/daemon/src/general-execution.ts), [paths][paths-doc], [installation guide][install-doc]
4. **Scripting and bounded results.** Exercise JSON plus noninteractive mode,
   explicit account/client selection instead of ambient `GOG_ACCOUNT`, both
   advertised Sheets input forms, and text export/readback. Current Docs cat
   defaults allow far more text than Veduta's 32 KiB combined command-output
   limit; choose smaller command bounds and detect truncation. A JSON-shaped
   output is not success if exit status, cancellation, timeout, or output limits
   say otherwise. [Automation guide][automation-doc], [Docs read source][docs-read-source], [general execution source](../../packages/daemon/src/general-execution.ts)
5. **Mail persistence and passive access.** Search/summary remains request-driven
   and preserves unread status. Native Gmail reads already passing do not waive
   this CLI proof. The general tool's transient mode discards stdout/stderr from
   the Agent result; ordinary mode returns redacted Untrusted output. Neither is
   proof of a complete safe transient-to-summary integration. Reuse or extend the
   general mail-result path so raw mail remains transient and only validated Mail
   summaries persist; demonstrate no mailbox fetch on startup or merely because
   a connection exists. [General execution source](../../packages/daemon/src/general-execution.ts), [ADR-0024](../adr/0024-pull-based-personal-mailbox.md), [security model](../SECURITY.md)
6. **Scope and effect separation.** A package grant, provider scope, or resource
   selection never auto-approves a send, event creation, cell update/append, or
   copy. Show exact editable effect Approvals; deny changed, replayed, stale,
   wrong-Space, wrong-account, and extra-resource requests. Broader upstream
   commands/scopes are not silently exposed. General execution still follows
   reviewed Skill/Agent policy plus Trace; it is not a semantic command sandbox.
   [ADR-0026](../adr/0026-skills-may-drive-general-tool-execution.md), [ADR-0032](../adr/0032-reviewed-extension-hub.md)
7. **Restart, recovery, and revocation.** Refresh/reconnect cannot lose an approved
   durable result or duplicate a remote effect. Restart during setup marks the
   attempt interrupted; wrong account, expired/revoked token, denied consent,
   missing scope/API, unavailable keyring, and failed dependency installation
   remain truthful and actionable. Resume the same originating job at most once
   after the matching completed grant. A failed/uncertain send, insert, append,
   copy, or clear is never automatically retried. Revocation blocks future calls
   without another Space gaining access. [ADR-0033](../adr/0033-chat-initiated-service-connections.md), [automation guide][automation-doc]
8. **Review evidence and cleanup.** Save safe per-row evidence: package/CLI hashes,
   host profile, reviewed account and granted scopes, sanitized inputs and
   provider IDs, before/after assertions, approval identity, owning Space result,
   refresh/restart outcome, and pass/fail/blocked reason. Never save credentials
   or raw personal content. Remove disposable local/provider test resources via
   an authorized cleanup path, run focused checks plus `pnpm check`, and accurately
   report worktree/remote/issue state. A full Verified claim needs every row and
   applicable failure gate; public distribution additionally needs human review.
   [Issue #184][issue184], [ADR-0032](../adr/0032-reviewed-extension-hub.md), [AGENTS.md](../../AGENTS.md)

## Proposed implementation slices

These are a suggested breakdown, not newly created issues or an accepted
implementation design. Each slice must use the common inspection, Service
connection, Space capability grant, Approval, and lifecycle mechanisms rather
than add a parallel Gog-only setup flow. All dependent implementation waits for
the blockers required by #184; source investigation and specification refinement
can continue meanwhile. [Issue #184][issue184], [issue-tracker contract](../agents/issue-tracker.md)

| Slice                                       | Localized deliverable                                                                                                                                                                     | Exit evidence / ordering                                                                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Package and dependency review            | Feed this exact inventory, canonical CLI pin, license/provenance gaps, source drift, permissions, and fourteen functions into #183's report.                                              | Read-only Chat inspection proves the complete report; no install or OAuth side effect. Resolve unknown mandatory behavior and the L2 clear path before an execution design is accepted.                               |
| 2. Protected CLI execution resources        | Reuse Service connection and general execution resources for explicit account/client/home, keyring access, protected secret delivery, and bounded results on a supported Gateway profile. | Protected setup/no-content identity probe, actual-scope display, missing keyring/failure recovery, and restart evidence; after #183/#181/#123's required blockers. No plaintext secret workaround.                    |
| 3. Calendar milestone                       | C1 read-only events first, then C2 separately approved creation on a disposable calendar.                                                                                                 | Two row proofs plus wrong-calendar/account, refresh, denial and uncertain-write tests. Publish any narrow derivative under a separate port identity; original Gog remains incomplete.                                 |
| 4. Gmail                                    | G1 metadata search and safe Mail summary handling, then G2 prepared/approved send.                                                                                                        | Two proofs, unread/passive/transient persistence assertions, controlled recipient, and no duplicate send. Existing native Gmail proof is not the exit criterion.                                                      |
| 5. Drive and Contacts reads                 | D1 search and P1 list with honest provider scopes and reviewed resource selection.                                                                                                        | Two proofs plus forbidden-resource/scope negatives and no automatic access to bundled extra contacts/directory scopes.                                                                                                |
| 6. Sheets                                   | S1/S2 reads, S3 update, S4 append, then S5 only after the permitted L2 path is decided.                                                                                                   | Five proofs including typed values/formulas, both input forms, preserved neighboring cells, uncertain-append recovery, and destructive-operation authority. A read/update-only subset does not complete original Gog. |
| 7. Docs                                     | T1 bounded export/readback, T2 bounded text reading, T3 approved Drive copy.                                                                                                              | Three proofs, protected local file paths/cleanup, copy scope/destination checks, and no accidental exposure of new upstream edit commands.                                                                            |
| 8. Full package lifecycle and release proof | Aggregate the exact original artifact, chosen dependency and all service rows; exercise restart, same-job continuation, revocation and truthful failure.                                  | Fourteen passing functions and the cross-cutting gates on the same approved environment. Only then consider #184 closure and Gog coverage in #193; package updates need a new diff/review/proof.                      |

The present recommendation is **adaptation required / not ready**, rather than a
claim of installation failure or unsafe behavior from a scan warning alone.
Remaining blockers are the open tracker prerequisites, missing live authorized
account/fixture evidence, protected CLI credential integration, scope overreach
that has not been approved or narrowed, package provenance/licensing gaps, and
the unresolved permitted L2 Sheets-clear path. Source support for commands and
matching dependency hashes resolves none of those live gates.

## Primary sources

Registry URLs are version-qualified where supported but still serve mutable
responses; the recorded hashes identify the bytes actually observed. CLI and tap
source links are immutable commit links. Google documentation is maintained
upstream and was consulted on the observation date.

[issue184]: https://github.com/Ic3b3rg/veduta/issues/184
[issue183]: https://github.com/Ic3b3rg/veduta/issues/183
[issue181]: https://github.com/Ic3b3rg/veduta/issues/181
[issue123]: https://github.com/Ic3b3rg/veduta/issues/123
[issue177]: https://github.com/Ic3b3rg/veduta/issues/177
[issue193]: https://github.com/Ic3b3rg/veduta/issues/193
[connection-audit]: https://github.com/Ic3b3rg/veduta/issues/181#issuecomment-5998112451
[catalog]: https://clawhub.ai/api/v1/skills/gog?ownerHandle=steipete
[manifest]: https://clawhub.ai/api/v1/skills/gog/versions/1.0.0?ownerHandle=steipete
[skill]: https://clawhub.ai/api/v1/skills/gog/file?path=SKILL.md&version=1.0.0&ownerHandle=steipete
[card]: https://clawhub.ai/api/v1/skills/gog/file?path=skill-card.md&version=1.0.0&ownerHandle=steipete
[download]: https://clawhub.ai/api/v1/download?slug=gog&version=1.0.0&ownerHandle=steipete
[cli-repo]: https://github.com/openclaw/gogcli
[release]: https://github.com/openclaw/gogcli/releases/tag/v0.43.0
[tag-ref]: https://api.github.com/repos/openclaw/gogcli/git/refs/tags/v0.43.0
[tag-object]: https://api.github.com/repos/openclaw/gogcli/git/tags/093e061ded12db5e0f38416c3be516a57d357303
[linux-archive]: https://github.com/openclaw/gogcli/releases/download/v0.43.0/gogcli_0.43.0_linux_amd64.tar.gz
[mac-archive]: https://github.com/openclaw/gogcli/releases/download/v0.43.0/gogcli_0.43.0_darwin_arm64.tar.gz
[go-module]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/go.mod
[go-sum]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/go.sum
[cli-license]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/LICENSE
[release-config]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/.goreleaser.yaml
[cli-readme]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/README.md
[brew-formula]: https://github.com/openclaw/homebrew-tap/blob/c38bffe27ebef0e97c55cfdad55b13355eab5f33/Formula/gogcli.rb
[brew-migration]: https://github.com/steipete/homebrew-tap/blob/5e25446e644a16bcd7ad56aeb945f7902c8a67c3/tap_migrations.json
[credentials-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/auth_credentials.go
[credentials-test]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/execute_auth_credentials_test.go
[auth-add-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/auth_add.go
[scope-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/googleauth/service.go
[docs-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/docs.go
[paths-doc]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/paths.md
[install-doc]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/install.md
[automation-doc]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/automation.md
[gmail-search-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/gmail_search.go
[calendar-events-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/calendar_events_cmds.go
[contacts-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/contacts_crud.go
[sheets-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/sheets.go
[export-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/export_via_drive.go
[docs-read-source]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/internal/cmd/docs_read.go
[cmd-gmail-search]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-gmail-search.md
[cmd-gmail-send]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-gmail-send.md
[cmd-calendar-events]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-calendar-events.md
[cmd-calendar-create]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-calendar-create.md
[cmd-drive-search]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-drive-search.md
[cmd-contacts-list]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-contacts-list.md
[cmd-sheets-get]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-sheets-get.md
[cmd-sheets-metadata]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-sheets-metadata.md
[cmd-sheets-update]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-sheets-update.md
[cmd-sheets-append]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-sheets-append.md
[cmd-sheets-clear]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-sheets-clear.md
[cmd-docs-export]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-docs-export.md
[cmd-docs-cat]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-docs-cat.md
[cmd-docs-copy]: https://github.com/openclaw/gogcli/blob/3b5122f4c81c5df6df38ee48e01327f1034364ee/docs/commands/gog-docs-copy.md
[gmail-list-api]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list
[gmail-send-api]: https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
[calendar-list-api]: https://developers.google.com/workspace/calendar/api/v3/reference/events/list
[calendar-insert-api]: https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
[drive-list-api]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list
[drive-export-api]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
[drive-copy-api]: https://developers.google.com/workspace/drive/api/reference/rest/v3/files/copy
[drive-auth-doc]: https://developers.google.com/workspace/drive/api/guides/api-specific-auth
[contacts-list-api]: https://developers.google.com/people/api/rest/v1/people.connections/list
[sheets-get-api]: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get
[sheets-metadata-api]: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/get
[sheets-update-api]: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/update
[sheets-append-api]: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/append
[sheets-clear-api]: https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/clear
[docs-get-api]: https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get
