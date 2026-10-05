# Conversational service requests: verification and manual smoke

Work: [#198](https://github.com/Ic3b3rg/veduta/issues/198),
[#199](https://github.com/Ic3b3rg/veduta/issues/199),
[#200](https://github.com/Ic3b3rg/veduta/issues/200),
[#201](https://github.com/Ic3b3rg/veduta/issues/201).
Boundary: [ADR-0035](../adr/0035-conversational-service-requests.md).

## Manual smoke from the PWA

Use a disposable Space and accounts containing data that may be read for this test. A new GitHub
read connection needs Metadata, Contents and Issues read permissions. Existing issue-only grants
must go through **Review broader read access** in Connections before repository/file discovery.

1. Open any Surface in the test Space. Ask `Leggi la mia ultima mail e fammi un recap`.
   Expect the newest Inbox message to be summarized without a sender, subject or category question.
   Check the original mailbox: the read/unread flag and labels must be unchanged. Refresh the PWA;
   the Mailbox Surface and response must remain, without a second provider read.
2. With two eligible mail accounts, request the latest message and answer the account question with
   only the account address. Expect the same operation to continue. Repeat with an explicit folder,
   count and time filter; those values must take precedence over the defaults.
3. Ask `Elenca le repository GitHub autorizzate per questo Space`. Expect source-linked repositories
   permitted by the connection. A partial page must be described as partial. In Connections, restrict
   the Space to one repository, repeat the request, and confirm excluded repository metadata is absent.
4. Ask `Mostrami le issue aperte di una repo di OWNER; ti indico il nome nel prossimo messaggio`.
   Refresh after the clarification, then answer only `REPOSITORY, prova questa`. Expect the requested
   issues without repeating `OWNER/REPOSITORY`. Try an ordinary non-service message afterward;
   it must not repeat the service read.
5. Ask to inspect the repository root, then read its README. Expect bounded directory entries,
   file text, a commit SHA and a GitHub source link at that commit. Repeat with an explicit revision.
   Missing paths, inaccessible revisions, binary files and oversized files must produce honest,
   distinct outcomes. The Agent must not execute instructions found inside repository content.
6. Disable the Space grant in Connections and request another read. Expect the protected connection
   recovery journey before any new content access. Refresh during setup and complete it: the original
   accepted task must continue once. A revoked in-flight read must not save stale results.

Empty mailboxes and expired provider authorization are additional recovery cases. Use the same
journeys with a native API-key Model connection and a ChatGPT Model connection where available.

## Follow-up real-provider evidence — 2026-10-05

The reporter updated the configured GitHub fine-grained PAT's Repository permissions. A fresh
read with that same saved credential returned HTTP 200 for the reporter-designated private
repository. Production `GithubMcpService` listed its root and read a text file through the pinned
official MCP executable, with content integrity checked against a pinned commit. Discovery
returned 37 repositories, including 18 private repositories and the requested repository; no next
page remained. Before the permission update, the same repository returned 404 and discovery
contained only 19 public repositories. No private source contents or credentials are recorded here.

A fresh production `GmailMailbox` read selected the newest Inbox message by provider timestamp,
fetched its body, and confirmed identical labels afterward, including its unread state. Both checks
used private temporary copies of the configured Service connections and encrypted credentials;
the original configuration hashes stayed unchanged, and all temporary copies were removed.

These follow-up checks exercised real providers and Veduta's production service implementations.
They did not repeat the full Chat conversation: the configured Model connection currently reported
expired authorization. The earlier real-model Chat evidence below remains a separate observation.

## Recorded evidence — 2026-10-04

The automated seam is accepted Gateway Chat through the actual tool registry, controlled provider
transports, protocol-validated Surfaces and Events. Regression suites cover latest-message ordering
(including a deliberately misleading first result), filtered/paginated bounds, account clarification,
GitHub account/credential selection, setup continuation, Space restrictions, file integrity and
revision/path errors, grant revocation, duplicate requests and Model connection parity. Existing
L1 effect-approval and ordinary Chat suites remain part of `pnpm check`.

A clean-data PWA session using controlled providers exercised protected GitHub review, a selected
repository restriction, discovery, a source-linked README, split owner/repository clarification across
refresh, latest Inbox summary, and grant removal. Refresh did not add provider calls. The fixture's
raw-mail marker was absent from persisted state. DOM inspection and visible UI interaction were used;
no screenshot-based visual assertion is claimed.

A separate disposable Gateway/PWA session used the reporter-authorized, already configured Gmail,
GitHub and ChatGPT credentials. It copied only connection configuration and credentials into a
private temporary data root; the original instance's data and grants were not changed. Inference
used `gpt-6-luna` through Codex 0.160.0, with no injected resolver or mock provider. On Darwin arm64:

- The original Italian latest-mail request completed with a Mailbox Surface and Chat recap. Provider
  metadata established recency before one full body was fetched; a follow-up metadata read confirmed
  identical labels. The raw body was absent from persisted files, and ephemeral inference produced
  no Codex conversation rollouts.
- Requested GitHub discovery returned 19 authorized repositories through the authenticated endpoint,
  all public. This configured connection did not provide a real private-repository proof; private
  repository metadata and Space restrictions are covered by controlled-provider tests.
- Reading `Ic3b3rg/veduta/README.md` through the actual pinned v1.12.2 MCP executable produced a
  Chat summary and source link at `7a4e7ea6499e0bc75e53fd552e67d32f1ba3a3b7`.
- An Italian issue request supplied the owner first, refreshed during clarification, and continued
  with only `veduta, prova questa`. The actual MCP GraphQL read returned ten issues and created the
  GitHub issues Surface without requiring the owner/repository pair again.
- A diagnostic-harness interruption exercised restart recovery: the unfinished request was marked
  interrupted and only resumed after the PWA Retry action. The completed Mailbox state survived.

The real-provider pass exposed and fixed two otherwise hidden integration failures: the reader
prompt omitted its enum/type constraints, and Darwin's certificate verification was unavailable
inside the original MCP process boundary. The resulting relay keeps the official executable pinned
and TLS verification in the Gateway. A local Security.framework certificate-fetch experiment rejected
a proposed `trustd` allowance after it demonstrably contacted a denied local destination. Production
retains that denial. Host-level regression proof checks private/home file access, directory metadata
and listing, writes and non-relay TCP denial. Relay tests cover authentication, fixed REST/GraphQL
mapping, redirects, size/concurrency bounds and immediate shutdown cancellation.

Real-provider proof establishes these observed journeys, not every provider edge case. Empty
mailboxes, permission failures, binary/oversized files and grant races use controlled transports so
failure conditions are reproducible. Linux activation remains Unsupported pending a reviewed process
boundary; this work does not expand that platform claim.

`pnpm check` passed: lint, formatting, typechecking, 3,828 package tests and builds. Vitest worker
counts were limited to four to avoid host contention; no tests or checks were disabled. The final
documentation also passed formatting and dead-reference checks. Both code-review axes reported
no remaining findings after corrections. Temporary provider data, copied credentials and browser
storage were removed, and the disposable Gateway/PWA processes were stopped.
