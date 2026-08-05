# 046 — Signed artifact URL: making a real GitHub release fetchable

## Context

Issue #43 shipped signed self-update end to end against a local fake feed and a throwaway
keypair, but never against a real, published GitHub release — and driving the production fetch
code (`packages/daemon/src/update/update-ports.ts`) at the real v0.0.1 asset showed why that
mattered: it refused every time.

`stageRelease` (`packages/daemon/src/update/update-transaction.ts`) passed the pinned _feed_ host
as the allowed host for the artifact download, and the fetch transport refused any redirect that
changed host. GitHub's own release-asset redirect changes host:

```
REFUSED: refusing a cross-host redirect: github.com -> release-assets.githubusercontent.com
```

The redirect target carries a short-lived signed credential in its query string
(`release-assets.githubusercontent.com/...?...&sig=...&jwt=...`). No release built the way
[ADR-0013](../docs/adr/0013-signed-self-update.md) decision 2 describes — a `veduta-vX.Y.Z.tar.gz`
attached to a GitHub release — could ever have been installed by the wrapper as written.

Tracing why the host pin existed at all surfaced the actual gap: `artifactUrl` lived only in
`UpdateManifestSchema` (the feed) and `UpdateMarkerSchema` — both **unsigned**. The pin was never
a defense against a compromised signing key (that key already controls the bytes at the URL); it
was the only thing standing between a feed-level attacker and a fetch target of their choosing. A
feed attacker who cannot forge a signature can still replay a genuinely-signed newer release's
metadata while substituting their own `artifactUrl`: the chain verifies, monotonicity passes, the
Update Surface offers it, and Apply issues a GET at the attacker's target from a machine inside a
home network. A later hash mismatch cannot un-issue that request.

The design is amended in [ADR-0013](../docs/adr/0013-signed-self-update.md)'s "Amendments (issue
#46 implementation)" section, which this issue implements.

## Goal

A real, published GitHub release can be installed with a single tap, with the fetch target chosen
by the same party that already chooses the release's bytes — the signing key — never by an
unsigned feed entry or an unsigned apply-time marker.

## Non-goals

- Re-litigating the two-tier signing ceremony or the transaction/rollback state machine (issue
  #43, unchanged here).
- A per-CPU-architecture artifact URL scheme — out of scope, same simplification `RELEASING.md`
  §(b)2 already documents for the Node runtime fields.
- Placing a timeout around the updater invocation in `deploy/veduta-run` — considered and
  deliberately deferred (ADR-0013's Amendments, issue #46, item 5); the shared download budget
  below addresses the stall that motivated it.
- Making v0.0.1 installable. Its signed metadata predates this issue's field and stays refused
  under the pre-existing feed-host pin — see Acceptance criteria below.

## Tasks

- **Signed `artifactUrl`**: add an optional `artifactUrl` to `ReleaseMetadataSchema`
  (`packages/protocol/src/update.ts`), signed alongside the rest of the release metadata. Optional
  so a release signed before the field existed still parses.
- **Conditional host pin**: `stageRelease` fetches the signed URL with no host pin and
  cross-host redirects allowed when `release.artifactUrl` is present; otherwise it fetches the
  manifest's URL via the marker with the pre-existing feed-host pin and same-host-only redirects,
  exactly as before.
- **Two-place refusal**: a marker `artifactUrl` that disagrees with the signed one is refused both
  at check time (`update-manager.ts`'s `runCheck`, the same path a bad signature takes) and again
  as a fail-safe inside the transaction itself (`stageRelease`), since the transaction process,
  not the daemon, is what actually dials the URL.
- **Shared fetch-policy module**: extract the https/loopback/redirect rules common to the feed
  fetch and the artifact fetch into `packages/daemon/src/update/fetch-policy.ts`
  (`assertFetchableUrl`, `resolveRedirect`, `describeUrl`), so both transports enforce the same
  rules from one place.
- **Feed fetch tightened**: `fetchCapped` (`update-manager.ts`) moves from WHATWG `fetch`'s default
  `redirect: 'follow'` (no https requirement, cross-host hops followed silently) to
  `redirect: 'manual'` with every hop resolved through `resolveRedirect`, https-or-loopback,
  same-host only.
- **Timeouts on the artifact transport**: an idle timeout and a single total download deadline
  (`update-ports.ts`), shared across every download one update transaction makes (artifact, Node
  runtime tarball, `SHASUMS256.txt`) via `remainingFetchBudgetMs`, rather than one budget per
  download.
- **Journal-derivation hardening**: `update-transaction.ts` re-derives the parsed release metadata
  from the signed `marker.release` bytes and re-runs `verifyReleaseChain` on every run that still
  has staging ahead of it (not only a fresh start), so a resume at the `downloaded`/`verified`
  phase — which still re-downloads the artifact — re-verifies the signature chain too.
- **Ceremony docs**: `RELEASING.md` §(b)3 gains the pre-signing `artifactUrl` check;
  `deploy/release.sh sign` prints the URL and its host for that check; §(b)6's `promote` verifies
  the signed URL instead of trusting a hand-typed `--artifact-url`; §(d)'s manual smoke checklist
  gains the fetch-from-another-host-and-hash step; §0's rehearsal harness serves the artifact from
  a second loopback host behind a redirect from the feed host.

## Acceptance criteria

- **AC1 — real GitHub redirect, driven directly**: the production fetch path (`fetchChecked`,
  `resolveRedirect`, `assertFetchableUrl`) fetches the real published v0.0.1 release asset
  end to end, following the actual `github.com` → `release-assets.githubusercontent.com` redirect,
  and the downloaded bytes' sha256 matches the release's signed `sha256`. (Evidence recorded:
  63,448,764 bytes downloaded across the cross-host redirect, hash matching.)
- **AC2 — signed URL lifts the pin, unsigned does not**: a harness release signed with
  `artifactUrl` present is fetched with no host pin and a cross-host redirect allowed; the same
  release with `artifactUrl` absent is refused a cross-host redirect exactly as before issue #46.
- **AC3 — marker/signed-URL mismatch is refused twice**: a marker whose `artifactUrl` disagrees
  with the signed release's `artifactUrl` is refused at `runCheck` before any marker is ever
  written, and — as a fail-safe reachable only by directly crafting a marker — refused again
  inside `stageRelease` before any bytes are fetched.
- **AC4 — feed fetch is host-strict**: a feed response with a cross-host redirect, or a plain
  `http://` feed URL on a non-loopback host, is refused by `fetchCapped` the same way the artifact
  fetch already refuses one — no code path in the update fetch retains WHATWG `fetch`'s default
  `redirect: 'follow'`.
- **AC5 — a stalled download does not hang the transaction forever**: a fixture server that
  accepts the connection and never sends bytes is defeated by the idle timeout; a fixture server
  that trickles bytes forever without ever completing is defeated by the shared total deadline;
  the artifact, the Node runtime tarball, and `SHASUMS256.txt` draw against one shared budget, not
  three independent ones.
- **AC6 — a resumed transaction still verifies before it re-downloads**: killing the transaction
  after the `downloaded` or `verified` phase and resuming it re-runs `verifyReleaseChain` against
  `marker.release` before `stageRelease` re-fetches the artifact — proven by mutation (an edited
  on-disk `release` field that disagrees with `marker.release` is caught, not silently trusted).
- **AC7 — the one criterion this issue cannot itself satisfy, recorded honestly**: a real one-tap
  install of a real GitHub-hosted release is **not** demonstrated by this change alone — v0.0.1's
  signed metadata predates the `artifactUrl` field, so a fixed instance offered v0.0.1 still holds
  it to the feed-host pin and still refuses the GitHub asset. That end-to-end install is satisfied
  by a v0.0.2 cut made after this issue lands, whose CI-built `release.json` carries the signed
  URL from the start. What this issue does have in hand instead: AC1 above (the real fetch path
  driven at the real asset) and the rehearsal harness (`scripts/rehearse-update.ts`) performing a
  genuine one-tap install across a redirect between two loopback hosts, exercising the same
  cross-host hop a real release goes through.
- Every criterion driven by tests except AC1 and the v0.0.2 cut in AC7, which are manual/one-time
  by nature (a real GitHub asset, a real release cut) and documented, not CI-gated — the same
  posture `RELEASING.md` §(d) already takes for issue #43's own manual smoke checklist.

## Dependencies

043; ADR-0013 (Amendments, issue #46 implementation)
