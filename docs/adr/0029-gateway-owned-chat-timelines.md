# The Gateway owns scoped Chat timelines independently of Agent sessions

Veduta needs a durable user-visible conversation, but Agent sessions contain provider and tool
state, a Space's Event log is canonical domain provenance, and Trace is bounded diagnostic data.
The Gateway therefore owns one durable, paginated **Chat timeline** for the global Chat scope and
one separate timeline per Space. Each contains only committed user messages, final Agent replies,
readable terminal errors, and identity-stable Pending-decision feedback; the PWA may cache pages but
never owns the only copy, ordering, retention, or scope.

Each **Chat submission** carries a client-generated stable identity. The Gateway acknowledges it
only after committing the user entry and accepted turn; repeating that identity returns the same
turn without appending or executing twice. The PWA retains an unacknowledged submission visibly for
retry. Accepted work is serialized in acceptance order within one Chat scope while different scopes
may run in parallel. At most eight accepted, nonterminal submissions may exist in one scope; an
overflow submission is not accepted and remains a visible PWA retry rather than hidden Gateway
work.

Live token deltas remain transient streaming delivery for the originating client and converge onto
Gateway-owned lifecycle and final entries visible to every client. A reload reconnects to the same
turn while its Gateway execution is live. After a Gateway crash, accepted work that never started
resumes once, while work that had started becomes Interrupted and requires an explicit Retry instead
of rerunning a possibly effectful turn. The global timeline lasts for the installation lifetime, and
a Space timeline remains available through Space archival. The old bounded browser array lacks
reliable identities, timestamps, and scope, so it is never uploaded or guessed into a canonical
timeline. The PWA stops treating it as authority but leaves existing legacy data untouched for a
separate future removal decision.

This boundary is deliberately independent of Agent SessionStore, Event log, Trace, Runtime log,
and provider threads. Projecting any of those into the PWA was rejected because their lifecycle and
contents serve different contracts; retaining chat only in browser storage was rejected because it
cannot converge across reloads, restarts, or authenticated devices. Implementation follows the
Gateway-owned direct PWA transport from ADR-0028 rather than extending a speculative Bridge
adapter. The implementation scope is tracked by issue #141.

Status: accepted
