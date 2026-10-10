# The System Space is a singular engine-owned GenUI namespace

Veduta needs one place for its own durable status and controls without turning system capabilities
into a second application model. Existing daemon-owned Surfaces already use the same validated Atom
catalog as user life-area Surfaces, but the boundary is incomplete: the canonical identity is
daemon-local, generic lifecycle and Agent paths can still target the Space, and Model usage and
Connected devices are appended while serving a snapshot instead of following the persisted Surface
lifecycle.

The protocol therefore owns `SYSTEM_SPACE_ID`, whose one canonical value is `spc-system`. The
Gateway guarantees exactly one active Space with that identity and is its only content and
lifecycle owner. Name and slug are presentation values, never classification; no configurable kind
flag or parallel System Space schema is introduced. The boot materializer is the only path allowed
to create a missing instance or repair an archived development instance. Ordinary creation and
import cannot claim the identity; exposed archive, restore, and merge paths compare it and refuse
before writing, with merge refusing it as either source or target. Any rename path must enforce the
same identity boundary.

An Agent turn scoped to the System Space remains conversational but receives only safe status reads
and explicit Gateway operations. It cannot create ordinary Surfaces, patch their content
generically, write FACTS or INSTRUCTIONS, or author Automations there. Requests for personal
content are directed to a user life-area Space. Actions deliberately exposed by daemon-owned
Surfaces remain available. Pinning and ordering are user presentation preferences rather than
content authorship, so they continue through their existing validated, evented paths.

Every visible System Surface is daemon-owned durable living state with a stable daemon-private
identity. It is validated, persisted, refreshed, recorded in the Space Event log, and delivered
live through the normal Surface engine. Model usage and production Connected devices move from
request-time projections to managers following that lifecycle, and the generic FACTS projection
does not apply to the System Space. A failed refresh retains the last valid Surface, exposes an
explicit stale or error state and last successful timestamp, and repairs the same Surface in place
after recovery. Reading the Space snapshot never creates or refreshes System content.

The PWA may use only the shared Space identity to place the canonical System Space in a visually
secondary fixed-shell group. Pinning and ordering its daemon-owned Surfaces remain ordinary
evented presentation preferences. The PWA never interprets individual System Surface identities
and never introduces a bespoke renderer, generated route, or generated markup; all content
remains generic validated GenUI.

Veduta has no production installations at the time of this decision, so no permanent migration for
legacy user-authored System content is added. Development state is disposable and will be reset
after the implementation graph lands. A future deployed-state migration would require a new
decision rather than speculative recovery machinery now.

The rejected alternatives are classifying by name or slug, adding a protocol-level System kind or
parallel model, using a bespoke administration screen, retaining request-time synthetic Surfaces,
allowing generic Agent writes, and forbidding harmless user presentation preferences. The
implementation slices and dependency on the Home Space grid are tracked by
[the System Space specification](https://github.com/Ic3b3rg/veduta/issues/63).

## Management placement amendment

The owner-approved workflow in [issue 234](https://github.com/Ic3b3rg/veduta/issues/234) places
FACTS, Space instructions, Automations and Nightly Reflection management in Settings. This amends
the original rejection of dedicated administration controls for these domains. The controls reuse
the Curator, Scheduler and Spaces engine, preserve their Space ownership and Events, and validate
all Gateway contracts. Canonical management projections receive shared protocol metadata from the
Gateway; the PWA does not infer management from a Surface title or daemon-private identity. The
Nightly Reflection report still uses the generic Atom renderer. Other System status Surfaces remain
in System, with their existing content and lifecycle authority.

[Issue 235](https://github.com/Ic3b3rg/veduta/issues/235) also exposes saved Space columns through an
explicit System Chat operation and Settings. This is the same evented presentation preference as
in ordinary Spaces and grants no generic content, Automation-authoring, memory, or lifecycle tools.

Status: accepted
