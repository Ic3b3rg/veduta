# 141 — Persist one Chat timeline per Chat scope

## Problem Statement

Veduta's visible conversation is currently a single browser-local array capped at 80 messages. It
has no durable entry identity, timestamps, pagination, or Chat scope, so global and Space-scoped
turns are mixed together and a reload, another device, cleared browser storage, or an interrupted
stream can show a different or incomplete conversation. The Agent's persistent SessionStore may
still contain model messages, but it is an internal inference record with tool and provider state;
it is not a safe or stable source for the user-visible conversation.

This caused confirmed Space-chat messages and replies to disappear after reload even though the
underlying Agent session still existed. Pending-decision feedback can also accumulate as duplicate
messages instead of updating one durable visible entry, and a disconnect mid-turn has no
Gateway-owned status from which the PWA can recover truthfully.

## Solution

Introduce a Gateway-owned durable Chat timeline for every Chat scope: exactly one global timeline
and one separate timeline per Space. Each timeline is complete, ordered, paginated, authenticated,
and available across reloads, Gateway restarts, and authenticated devices. A Space timeline remains
available when its Space is archived.

The Chat timeline contains only user-visible conversation: committed user messages, final Agent
replies, readable terminal errors, and identity-stable Pending-decision feedback updated in place.
Agent tool calls, retries, model events, reasoning, and diagnostics remain in Agent sessions and
Trace rather than becoming chat content. The Space Event log remains canonical provenance and is
not repurposed as conversation storage.

A Chat submission carries a client-generated stable identity. The Gateway acknowledges acceptance
only after durably recording the user message and accepted turn; repeating the same identity returns
the same turn without appending or executing twice. Live frames continue to provide streaming UX,
while the committed Chat timeline is authoritative for acceptance, lifecycle, completion, and
failure. A reload reconnects to the same live turn when the Gateway still owns it. If the Gateway
stopped, accepted work that never started resumes once, while work that had started becomes
Interrupted and offers an explicit Retry; recovery never automatically reruns a possibly effectful
turn.

## User Stories

1. As a Veduta user, I want my global conversation to survive a page reload, so that the omnipresent chat remains continuous.
2. As a Veduta user, I want each Space to have its own Chat timeline, so that Health conversation does not appear inside Work and vice versa.
3. As a Veduta user, I want the global Chat timeline to remain separate from every Space timeline, so that cross-Space coordination does not erase focused context.
4. As a Veduta user, I want a submitted message to appear durably before the Agent finishes, so that reloading during a long turn does not lose what I asked.
5. As a Veduta user, I want a reload during a still-running turn to reconnect to that same turn, so that streaming can continue without duplication.
6. As a Veduta user, I want a turn interrupted by Gateway shutdown to be labelled Interrupted, so that partial text is not mistaken for a completed answer.
7. As a Veduta user, I want interrupted work to rerun only after I explicitly choose Retry, so that external or durable effects are never repeated automatically.
8. As a Veduta user, I want Retry to preserve a visible relationship to the interrupted request, so that I can understand why a second turn exists.
9. As a Veduta user, I want final Agent replies and readable terminal errors to survive restart, so that success and failure are equally durable.
10. As a Veduta user, I want Pending-decision progress and outcome to update the same visible entry, so that resolving one decision does not create a trail of contradictory bubbles.
11. As a Veduta user, I want tool calls, retries, and model internals excluded from normal chat, so that the Chat timeline stays readable.
12. As an operator, I want diagnostics to remain in Trace, so that troubleshooting detail is available without turning the user conversation into an operational log.
13. As an Agent, I want SessionStore to remain independent from the Chat timeline, so that model compaction, provider changes, and internal tool messages cannot alter visible conversation.
14. As a Veduta user on another authenticated device, I want to see the same committed Chat timeline, so that conversation is installation-owned rather than browser-owned.
15. As a Veduta user with two open devices, I want new committed entries and in-place updates to converge without duplicates, so that both clients show the same sequence.
16. As a Veduta user, I want to page backward through the complete timeline, so that older messages are not destructively removed by a client-side cap.
17. As a Veduta user, I want newest messages to load quickly while older pages remain available on demand, so that durable retention does not make chat startup unbounded.
18. As a Veduta user, I want a Space's Chat timeline retained after archival, so that archiving organization does not erase conversation.
19. As a Veduta user, I want a global Chat timeline retained for the lifetime of the installation, so that switching Spaces does not define its retention.
20. As a Veduta user, I want messages that link to affected Spaces and Surfaces to keep those targets after reload, so that prior results remain navigable.
21. As a Veduta user, I want an offline queued submission to become one durable message when accepted, so that reconnect cannot send duplicates.
22. As a user whose browser still contains the old local array, I want Veduta to start the new authoritative timeline without guessing scope or timestamps, so that fabricated migration data cannot corrupt it.
23. As a contributor, I want stable entry and turn identities at the Gateway boundary, so that replay, reconnect, Pending-decision replacement, and retries can be tested without timing heuristics.
24. As an authenticated operator, I want Chat timeline access to follow the existing PWA authentication boundary, so that another browser cannot read conversation without a valid session.

## Implementation Decisions

- Add one durable Gateway-owned Chat timeline store. The scope key is either global or exactly one
  Space id; there is one global timeline and one separate timeline per Space, never one unified
  installation-wide sequence presented with client-side filtering.
- Keep the Chat timeline distinct from Agent SessionStore, Event log, Trace, Runtime log, and
  messenger Bridge state. None of those sources is projected or reverse-engineered into visible
  chat entries.
- Give every Chat submission a client-generated stable identity retained across reconnect and every
  durable timeline entry a Gateway-owned immutable id, scope, role/kind, creation time, update time,
  and monotonic scope-local ordering cursor. Ordering is decided by the Gateway rather than browser
  clocks.
- Commit the user entry and accepted turn before acknowledging the Chat submission or starting Agent
  execution. The PWA removes a submission from its retry queue only after this acknowledgement. A
  duplicate identity returns the original accepted turn and cannot append or execute it twice,
  including when the first acknowledgement was lost.
- Serialize accepted submissions in acceptance order within one Chat scope while allowing different
  scopes to execute in parallel. Admit at most eight accepted, nonterminal submissions per scope.
  Over-capacity work is not accepted or hidden in the Gateway; the PWA retains it visibly for retry.
- Persist one lifecycle for each accepted turn, including accepted, running, completed, failed, and
  interrupted outcomes. Startup recovery resumes accepted work that never started exactly once and
  marks previously running work Interrupted unless the same live Gateway execution still owns it;
  it never infers completion from partial session or Event-log data.
- Keep live streaming frames for immediate presentation, but make committed timeline entries the
  authority. Accepted/running state and terminal outcomes converge to every connected client.
  Token deltas are transient, normally target the originating client, and are not replayed or
  appended as durable messages. Completion creates or finalizes one assistant entry carrying the
  exact final `ChatMessage` content and result targets.
- On socket reconnect or page reload, allow the PWA to subscribe to an existing live turn by stable
  turn id and reconcile it with the latest durable timeline page. Duplicate live and replayed
  delivery is idempotent.
- When a Gateway process dies mid-turn, show the committed user message and one Interrupted outcome
  with an explicit Retry action. Retry creates a new user-authorized turn linked to the interrupted
  turn; it is never an automatic resume or replay of effects.
- Store user messages, final Agent replies, readable terminal errors, and Pending-decision feedback
  in the Chat timeline. Preserve structured Space and Surface result targets needed for durable
  links.
- Give Pending-decision feedback one durable identity tied to the decision. Resolving and terminal
  lifecycle changes replace that same entry in place with increasing revision; they do not append
  competing status messages.
- Keep model deltas, tool calls and results, failover attempts, retries, provider reasoning,
  internal prompts, and diagnostics out of the Chat timeline. Agent SessionStore and Trace retain
  their existing respective responsibilities.
- Expose authenticated cursor-based pagination for one Chat scope, returning deterministic stable
  order and a bounded newest page by default. The PWA loads older pages on demand and merges pages
  and live entries by identity rather than array position.
- Retain the global Chat timeline for the installation lifetime and each Space timeline through
  Space archival. v1 has no destructive retention cap, expiry, clear, or delete operation.
- Replace browser-local chat authority with Gateway reads and live updates. Browser storage may
  cache a validated recent page for offline presentation and may retain the existing outbound
  queues, but it cannot own retention, ordering, scope, terminal state, or the only copy of a
  committed entry.
- Do not upload, scope, or migrate the legacy bounded local chat array. Its messages lack stable
  scope, identity, and trustworthy timestamps. Stop reading or writing it as Chat authority, leave
  existing legacy browser data untouched for a separate future removal decision, and start
  clean-data verification with no canonical entries fabricated from it.
- Build on the Gateway-owned direct PWA transport established by ADR-0028 and issue #139, then use
  the single PWA live-state authority established by issue #155. Do not add timeline behavior to the
  speculative ChannelAdapter that #139 removes, keep a parallel React-owned timeline state, or
  invent a messenger-wide transport abstraction.
- Preserve the existing single Agent, global multi-Space tools, focused-Space tool boundaries,
  Connection parity, trust gates, result targets, Event log writes, and Pending-decision contract.
  Durable visible conversation does not change which tools a turn receives or what context the
  Agent sees.

## Testing Decisions

- The authoritative acceptance seam is the existing clean Local VPS full-stack browser journey with
  the real PWA, Gateway, authentication, WebSocket lifecycle, deterministic Model connection, and a
  fresh isolated data root. Tests assert user-visible conversation rather than SQLite tables or
  SessionStore entries.
- The browser journey writes distinct global, Health, and Work conversations; switches among their
  scopes; reloads each route; restarts the Gateway on the same root; and proves that every timeline
  remains separate, ordered, and complete.
- A second authenticated browser context proves committed entries and Pending-decision replacement
  converge across devices without duplicates. Browser-local state is cleared on one context to
  prove the Gateway remains authoritative.
- The journey creates more than one page of entries, loads the newest page first, requests older
  pages, and proves the merged visible order has neither gaps nor duplicates. Tests assert public
  cursor behavior rather than database offsets.
- A controlled long-running turn is reloaded while its Gateway execution remains live and resumes
  the same turn. A separate test stops the Gateway after the user entry commits, restarts it, proves
  the Interrupted outcome, and verifies that no Agent or tool effect reruns until the explicit Retry
  action is used.
- Acceptance tests lose the first acknowledgement, resend the same Chat submission, and prove one
  durable user entry and one Agent execution. They also restart with accepted-but-not-started work,
  prove it starts once, and reject a ninth nonterminal submission in one scope while another scope
  remains available.
- A Pending decision moves through pending, resolving, and terminal states while the browser is
  online and while it is disconnected. In both cases one identity-stable timeline entry converges
  to the authoritative final feedback.
- Add a Gateway public-contract suite for authenticated scope pagination, stable identities,
  monotonic ordering, idempotent submission, atomic user-entry acceptance, lifecycle recovery,
  in-place revision, archival retention, and cross-Space isolation. SQLite schema details are not
  the acceptance boundary.
- Preserve existing AgentRunner session and Trace tests and add negative assertions that their
  internal messages are not copied into normal timeline pages. Do not make the visible timeline a
  provider-specific transcript.
- Run a documented non-CI smoke with an authorized ChatGPT Model connection: submit the reported
  Health and Work messages, reload, restart, and verify the same scoped durable entries without
  relying on provider thread retention.
- `pnpm check` and the relevant browser E2E job must pass from clean data before any implementation
  ticket is complete.

## Out of Scope

- Full-text search, export, manual deletion, configurable retention, expiry, or compliance archival
  for Chat timelines.
- A unified global-and-Space conversation, cross-Space message duplication, or moving entries
  between Chat scopes.
- Rendering tool calls, model reasoning, retry details, Trace events, Runtime logs, or Event-log
  records as ordinary chat entries.
- Replacing Agent SessionStore, changing model-context compaction, reusing provider threads, or
  making the Chat timeline the Agent's execution transcript.
- Automatically retrying interrupted turns or inferring that a partially observed external effect
  is safe to run again.
- Rich messenger conversation, a new Bridge, or a shared PWA/Bridge transport abstraction.
- Multi-user tenancy or new authorization roles beyond the existing authenticated installation.
- Uploading or canonically migrating the old browser-local 80-message array. Its later explicit
  export or removal is separate work; this change does not delete it during startup.

## Further Notes

- Issue #118 removes duplicate provider-owned Codex thread retention but deliberately leaves
  Veduta's SessionStore and conversation policies unchanged. It neither supplies nor blocks the
  user-visible Chat timeline.
- Issue #139 owns direct Gateway↔PWA transport simplification and issue #155 owns the PWA live-state
  authority. Timeline implementation starts from those seams rather than extending the adapter being
  removed or adding another React-owned reducer.
- The accepted domain terms are Chat scope and Chat timeline. A Chat timeline is not an Agent
  session, Event log, Trace, or browser-local transcript.
