# Pending decisions are channel-neutral views over workflow-owned state

Veduta has several workflows that wait for one explicit user choice: trust approvals, Tree
proposals, Space proposals, and verified update offers. Their business rules differ, but every
authenticated user channel needs the same durable answer to two questions: which choices are
pending, and what happened when one exact choice was resolved?

The protocol therefore defines **Pending decision** as a validated, channel-neutral read and
resolution contract. Each decision exposes a stable id, kind, safe summary, scope, allowed
resolutions, state, timestamps, actor, authoritative outcome, and optional Decision Surface id.
Ids use the protocol-owned `<kind>:<native-id>` codec so the Gateway can route an exact identity
without interpreting model prose or relying on channel-local aliases. Summaries are
delimiter-neutralized and bounded before validation.

The Gateway owns one `PendingDecisionService` and exposes it through authenticated list and resolve
routes. A resolution requires the explicit `trusted:user` actor, validates the requested operation
against the decision's allowed resolutions, and is coalesced with concurrent requests for the same
id. Terminal decisions are replayed as terminal results rather than executed again. Untrusted
content, proactive work, model output, and provider-native tools have no entry point that can mint
the actor or transition a decision.

The shared service is not a second business-state repository. Each kind joins through a small
adapter, and that adapter delegates resolution to the existing workflow authority. The trust layer
keeps approval execution and expiry; the Tree-proposal manager keeps version checks and guarded
SQLite transitions; the Space-proposal store keeps idempotent Space creation and Event recording;
the update manager keeps release verification and the updater handoff. Workflow-owned durable
state remains authoritative across restart, while adapters project it into `pending`, `resolving`,
or `terminal` with a truthful outcome.

Persistence and recovery stay specific to the external effect. Space proposals persist their
claim before creating files and retry recoverable partial creation until the Space and its Event
agree; only a deterministic identity conflict becomes a failed terminal outcome. Update offers
persist verified versions and user claims alongside updater state, and reconcile an orphaned claim
without resurrecting the offer. Tree proposals persist stale-target refusal as a terminal outcome.
The owning state machines remain the final exactly-once gates even when requests arrive through
different channels or repeated Gateway process lifetimes.

The alternatives rejected are a universal Pending decision database, which would duplicate and
eventually disagree with each workflow's authority; letting Decision Surfaces or model-authored
chat text own resolution state, which would make presentation equivalent to consent; and adding a
channel-specific endpoint for every workflow, which would repeat identity, validation, and replay
semantics. Natural-language selection, navigation, fixed-shell presentation, and outcome
notifications remain separate channel work.

Status: accepted
