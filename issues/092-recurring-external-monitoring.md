# 092 — Monitor public websites through goal-directed quarantined Automations

## Context

A recurring Automation with a briefing such as “check this newsletter and summarize its latest
article” currently copies that text into a system notice and stops. It performs no HTTP read, does
not invoke a quarantined reader or Worker, and does not update the requested Surface. The live
Worker registry is empty.

The desired behavior is semantic monitoring, not byte comparison. A newsletter home page may
change for navigation, advertising, or timestamps while the relevant article is unchanged; it may
also link to a new article whose useful content lives on another page of the same approved site.

Provider-native browsing and web search remain impossible. Veduta owns the complete fetch,
isolation, interpretation, persistence, and outcome path.

## Resolved creation contract

Creating or changing a Website monitor produces one editable Pending decision that shows:

- the owning Space;
- the exact approved HTTPS host set;
- the schedule;
- the Agent's interpreted monitoring goal;
- the proposed target Surface.

The Agent may propose a clearly suitable existing Surface or a dedicated new one. Confirmation may
change the goal or target, but the target must belong to the same Space. Authorization applies only
to that Automation. A discovered or redirected host outside the confirmed set pauses the occurrence
and creates a new Pending decision before any request to that host.

The durable rationale and security boundary are recorded in
[ADR-0022](../docs/adr/0022-goal-directed-website-monitors.md) and
[SECURITY.md §3.6](../docs/SECURITY.md#36-website-monitors).

## Execution contract

The high-level flow is:

`due occurrence → conditional seed read → goal-directed quarantined discovery → bounded same-host
reads → isolated full-text interpretation when required → semantic change decision → structured
Surface update → issue #91 outcome delivery`

- The first slice accepts public HTML and RSS/Atom over HTTPS. It does not use credentials, browser
  sessions, authenticated pages, paywalls, PDFs, media, or attachments.
- Every request uses manual redirects and explicit ceilings for redirects, documents, decoded bytes,
  total bytes, request duration, occurrence duration, and per-Space rate. Those limits are centralized,
  documented, and covered at their boundaries.
- URL validation rejects userinfo, non-HTTPS network URLs, unapproved hosts, DNS rebinding, loopback,
  link-local, private, multicast, and otherwise non-public destinations on every request and redirect.
- ETag and Last-Modified are used when available. An unchanged validator ends the occurrence without
  model work, Surface rewrite, or user-visible outcome.
- When bytes changed, a tool-less quarantined reader applies the confirmed goal and returns only
  schema-valid candidate metadata. It may select a bounded number of links on approved hosts for
  further reads. Raw pages never enter the primary Agent's context.
- A selected long document may use the isolated full-text/Worker path. Worker output remains
  Untrusted and cannot receive egress, command, filesystem, MCP, or provider-native tools.
- A semantic digest over the structured relevant result, not the complete page bytes, decides
  whether the target Surface changed.

## Persistence, retry, and outcome contract

- Durable monitor state includes the approved hosts, goal, schedule, target, validators, semantic
  digest, source URL, last check, last successful result, current safe error, and retry state.
- Restart preserves validators and the semantic digest; unchanged content is not rediscovered as new.
- One occurrence makes one initial attempt and at most two bounded retries, respecting `Retry-After`
  and backoff without extending the occurrence deadline or overlapping the next claim.
- Exhausted failure retains the last valid Surface, records safe status, and creates one coalesced
  In-app notification through issue #91. Repeated equivalent failures update that notification;
  successful recovery updates the Surface and creates one recovery notification.
- Every state mutation and outcome appends a compact Event in the owning Space. Raw content, secrets,
  response headers, and sensitive URL components never enter Event, notification, Trace, or chat text.

## Acceptance criteria

- [ ] The confirmation preview exposes and permits editing of Space, approved hosts, schedule, goal,
      and target Surface; cross-Space targets are refused.
- [ ] A known newsletter home can lead the quarantined flow to a relevant new same-host article and
      one structured Surface update without provider-native browsing or web search.
- [ ] Cosmetic page churn produces no Surface rewrite or In-app notification when the structured
      relevant result is unchanged.
- [ ] An unchanged validator performs no reasoning call and only advances freshness/provenance.
- [ ] A new host is never contacted before a new Pending decision is accepted.
- [ ] Redirect, DNS rebinding, private-network, size, timeout, content-type, rate, and traversal tests
      fail closed, including across every redirect and discovered link.
- [ ] Restarts retain conditional and semantic state without treating old content as new.
- [ ] Initial failure, two retries, repeated failure, and recovery follow the issue #91 Surface and
      In-app notification contract without overlapping occurrences.
- [ ] An injection corpus proves raw content cannot reach the primary Agent or obtain egress/L1+
      capabilities; only validated Untrusted structured data crosses the quarantine boundary.
- [ ] `pnpm check` and a deterministic end-to-end fixture pass.

## Out of scope

- General web search or unrestricted crawling.
- Provider-native web, command, filesystem, MCP, or browser tools.
- Authenticated pages, paywalls, cookies, PDFs, media, and attachments.
- Cross-Space monitoring or mutation.
- Browser push or assistant chat delivery for Website monitor outcomes.

## Blocked by

- [Issue 038](038-agent-loop-proactive.md) — live proactive quarantined-reader completions.
- [Issue 039](039-agent-loop-workers.md) — isolated Worker and full-text execution.
- [Issue 091](091-automation-outcome-delivery.md) — durable In-app notifications, outcome state,
  history, and context hygiene.
