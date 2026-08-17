# 092 — Execute recurring external-monitoring Automations through a quarantined reader

## Context

Creating a recurring Automation with a briefing such as “check this website and summarize the
latest article” does not execute that work. On each occurrence the Scheduler copies the briefing
into a system notice and stops. It performs no HTTP read, does not invoke a quarantined reader or
Worker, and does not update the requested Surface. The Worker registry is currently empty in the
live composition.

Provider-native web search is deliberately disabled and must remain impossible under
[issue 070](070-codex-tool-parity.md). It is not a fallback for this feature.

## Goal

Add a Veduta-owned recurring external-monitoring path for a known URL. A due Automation performs a
bounded, policy-approved read, detects whether the relevant resource changed, processes Untrusted
content only through the repository's isolation boundaries, and updates a linked Surface with a
structured result. Model work and user attention occur only when the fetched state requires them.

The intended high-level flow is:

`Automation occurrence → safe conditional read → change decision → quarantined processing →
structured Surface update → outcome delivery`

## Decisions required before implementation

- Define URL authorization and egress policy, including redirects, DNS/private-network defenses,
  content types, maximum bytes, timeouts, and per-Space rate limits.
- Define the durable monitor state used for conditional requests and change detection, such as
  ETag, Last-Modified, and/or a content digest.
- Define how an Automation binds to a target Surface and which schema owns the last successful
  result, last checked time, source URL, and error state.
- Define the exact handoff between deterministic fetching, quarantined reading, full-text
  isolation, Worker investigation, and the primary Agent. Raw external content must never enter
  the ordinary Space session.
- Define retry, backoff, duplicate-content, redirected-URL, malformed-document, and prolonged
  failure behavior.

## Preliminary acceptance boundary

- [ ] Polling an unchanged resource performs no reasoning call, produces no conversational
      message, and does not rewrite the target Surface.
- [ ] A meaningful change produces one schema-valid Surface update with source provenance and a
      change-aware summary.
- [ ] Every external byte is treated as Untrusted and passes through the established quarantined
      or dedicated full-text boundary before model interpretation.
- [ ] Fetches reject unsafe destinations and remain bounded by explicit size, timeout, redirect,
      and rate limits.
- [ ] Restarts retain conditional-read state and do not treat unchanged content as new.
- [ ] Failures become visible according to the Automation outcome-delivery policy without
      inventing article content.
- [ ] Provider-native command, filesystem, MCP, and web-search tools remain disabled.

## Related work

- [Issue 013](013-quarantined-reader.md) defines quarantined reading and taint propagation.
- [Issue 015](015-security-hardening.md) defines egress and injection hardening.
- [Issue 018](018-push-notifications.md) defines notification budgets.
- [Issue 070](070-codex-tool-parity.md) requires provider-native tools, including web search, to
  remain impossible.
- [Issue 086](086-automation-worker-external-event-traces.md) covers diagnostic traces for
  Automations, Workers, and external events.

## Out of scope

- General-purpose web search or browsing by the primary Agent.
- Executing arbitrary user-authored code or provider-native tools.
- Monitoring authenticated pages in the first slice.
- Cross-Space monitoring or mutation from global chat.

## Blocked by

- [Issue 038](038-agent-loop-proactive.md) — live proactive completions, including the quarantined
  reader.
- [Issue 039](039-agent-loop-workers.md) — real isolated Worker and full-text runs.
- [Issue 091](091-automation-outcome-delivery.md) — Automation outcome-delivery policy.
