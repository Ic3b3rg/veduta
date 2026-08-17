# A Template is a Surface's composition without its data, and a pin turns tree patches into proposals

A **Template** (`CONTEXT.md`) is what a Surface's Atom tree becomes once it has stopped changing: the
composition and the _names_ of the state keys it binds — never the data, and never a stored structural
signature either: that signature is derived from the tree on every read (`treeSignature`), so an
imported bundle can never advertise a shape its own tree does not have. The
Agent reuses Templates instead of reinventing compositions, and the user can **pin** a Surface, which
locks its tree: state keeps updating, while a tree patch becomes a **proposal** the user accepts or
rejects from a preview. Templates export and import as a JSON bundle, the seed of the post-v1
registry ([issue 022](../../issues/022-emergent-templates.md), [ADR-0003](0003-declarative-atoms.md)).

Status: accepted

## What "without data" means concretely

Data lives in two places in a Surface, and both are handled:

1. **Typed state** is never copied. A Template records `stateKeys` — the keys the tree binds and the
   keys its fast actions target — and instantiation seeds every one of them with `null` for the caller
   to patch real values into. This is also what `SurfaceSchema`'s binding validation requires, so an
   instantiated Surface is valid before it holds a single value.
2. **`props`** are kept, because a label _is_ the composition — stripping labels would defeat the
   visual consistency across regenerations this feature exists for — but reduced to structural
   scalars: a string longer than `TEMPLATE_PROP_MAX_CHARS` becomes empty, and any array- or
   object-valued prop (`Table.rows`, `Chart.series`, `Select.options`) is dropped with its key
   recorded in the Template's `dataProps`, so the reuse path knows exactly what must be filled in.

The rejected alternative was a per-Atom allowlist of "template-safe" props. The Atom catalog is closed
but its `props` are deliberately untyped (`packages/protocol/src/atom.ts`), so an allowlist would
either duplicate the catalog's rendering knowledge inside the daemon or turn into a protocol-wide
typed-props project — a change to ADR-0003's contract rather than an application of it. The two rules
above are the same guarantee at a fraction of the surface area, and they hold on the automatic reuse
path, not only at export.

## Matching is deterministic

Reuse must not depend on a model call: the match combines token overlap over the Template's `intent`
and `name` with equality of the Atom-type signature — the issue's "match on intent/type", literally.
The Space's own Templates are considered first, then those of the other active Spaces (recreating a
tracker in _another_ Space is the point). Regenerating a composition from scratch when a Template
matches is **refused** unless the Agent supplies a justification, which is recorded in the Event log:
the ordinary creation path is where reuse is enforced, so reuse is not an opt-in tool the Agent can
forget.

## Saving is lazy, and never silent

A Surface is eligible when its tree has not been restructured for `STABILITY_DAYS`, tracked by a
`tree_updated_at` stamp that only tree patches move. The harvest runs on the paths that would use a
Template (the Agent's template reads and the create-time match) and when the user pins, rather than
from a nightly job: a Template exists only to be reused, so materializing one the instant it could be
reused is indistinguishable from materializing it overnight — and it costs no cron entry, no config
knob, and no second nightly Automation competing with the Reflection, which owns memory consolidation
and not UI. Every save appends a `template.saved` event, and every pin appends `surface.pin`: the
Agent must be able to find out that its own compositions were captured (ADR-0003's memory contract).

## The pin is a capability, not an actor

Pinning is enforced in `SurfaceEngine.patchTree` — the single write path for tree changes, the same
placement as the daemon-ownership check — and a pinned Surface refuses _every_ tree patch unless the
caller passes an explicit bypass, which only the proposal manager does after the human accepts.
Refusing "by actor" (allowing `updatedBy: 'job'` through) was rejected: every daemon-owned Surface
manager writes as `job`, so the pin would have been one refactor away from silently evaporating.
A proposed patch is dry-applied and re-validated when it is _proposed_, so an invalid tree change is
refused then rather than at the moment the human clicks Accept, and Accept re-checks the tree version
and refuses visibly if the tree moved meanwhile.

Locking and unlocking are not symmetric capabilities. The Agent's `pin_surface` tool may only pin
(its schema accepts `pinned: true` and nothing else); unpinning is reachable only through
`POST /api/surfaces/:surfaceId/pin`, a human act gated by the same authenticated session every other
`/api/surfaces` route requires. The reasoning is the same one that keeps `patchTree`'s bypass out of
every daemon-owned manager's reach: an `L0` tool that could both unpin and then patch the tree freely
would make the pin guarantee one tool call away from not existing. `TemplateEngine.pin` itself takes
the caller's `origin`/`updatedBy` as parameters rather than assuming one, so the route stamps the
honest `{ origin: 'trusted:user', updatedBy: 'user' }` and the tool stamps the turn's own live-taint
write origin with `updatedBy: 'agent'` — a pin or unpin event is never attributed to the wrong actor.

The preview itself is an ordinary daemon-owned Surface with fast-path Accept/Reject buttons, exactly
like an approval card. The trust layer was deliberately _not_ reused: trust levels classify actions
that leave the daemon ([ADR-0007](0007-trust-levels.md)), and a tree patch never does.

## Pinned prominence is shared state

A Pin is also persistent visual priority, not only a tree lock. Each Space presents a separate
pinned group before its regular Surfaces. A newly pinned Surface enters first (last pinned, first
shown), and manual movement can reorder Surfaces within that group but cannot move one across the
group boundary; only Pin and Unpin make that transition. Unpin places the Surface first in the
regular group. Both transitions are strictly idempotent: requesting Pin for an already pinned
Surface or Unpin for an already regular Surface is a no-op, with no Event, freshness update, or
reordering. Position changes belong only to Move. The PWA renders a labelled Pinned section only
while that group is non-empty, with the regular Surfaces section following it whenever that group is
non-empty too. Empty groups do not occupy layout space or render drop targets; only a wholly empty
Space renders the existing No Surfaces state. The pinned group
has no numeric limit: Pin also protects composition, so presentation density cannot make that
capability arbitrarily unavailable. Manual Move up/down controls operate only within their current
group and disable at its boundaries; drag-and-drop is a separate presentation enhancement, not part
of this ordering contract.

Surface ordering belongs wholly to the Gateway as two ordered groups per Space, and both groups
converge across clients and reloads. Splitting ownership — pinned order in the Gateway but regular
order in the PWA's local preference — was rejected: Pin and Unpin cross that boundary, so the same
accepted action could otherwise produce different positions on different devices. Keeping all
ordering in the browser was rejected too: a fresh client could not recover
last-pinned-first-shown order. Manual reordering sends a relative Move within one group rather than
replacing an entire ordered list; the Gateway serializes those commands against its current order,
so clients cannot silently overwrite one another's arrangements. Pin, Unpin, and Move are not queued
while a client is offline: the PWA keeps the last Gateway-confirmed order, reports the action as
unavailable, and lets the user retry after reconnecting. In particular, replaying a relative Move
later against a materially different shared order would make its result surprising. While an online
Pin, Unpin, or Move is pending, the PWA keeps the last confirmed order and disables the affected
control against duplicate input. It applies only the Gateway-confirmed result; a rejected action
leaves the order unchanged and reports the error. A newly created regular Surface enters first in
the regular group,
immediately after the pinned group, so successful creation is visible without outranking a Pin. If
that creation belongs to a chat turn initiated by the current tab, only that tab scrolls to and
briefly highlights the new Surface; other clients apply the shared order without moving their
viewport. That initiating relationship must be explicit turn/client correlation, never inferred
from timing or from whichever turn happens to be active when `surface.created` arrives. Every
accepted Pin still updates every client, but only the tab in which the user directly pressed Pin
scrolls the moved Surface to the viewport centre and briefly highlights it. A local chat-created
Surface receives the same treatment in its initiating tab. Motion is smooth unless the user prefers
reduced motion, in which case positioning is immediate and the highlight does not animate. Agent,
remote-client, and replayed Pin events reorder without hijacking the viewport. Unpin moves the
Surface without scroll or highlight.

An existing installation that has no Gateway order backfills it from its durable Surface Event
stream, never from whichever browser connects first. Currently pinned Surfaces are ordered by their
latest accepted Pin, newest first; regular Surfaces are ordered by their latest creation or Unpin,
newest first, with a stable identifier fallback where legacy history is incomplete. Browser-local
orders are deliberately discarded after the authoritative snapshot arrives: they may disagree
across devices, so none can be promoted to shared truth without an arbitrary winner.

## An imported bundle is untrusted content

A bundle is a file written by another installation — attacker-reachable text, like the material
[ADR-0010](0010-importer-trust-and-refusal.md) governs. Import validates in a fixed order: a byte cap
before the file is read, an **iterative** walk enforcing depth, node, count and string caps (the Atom
schema is recursive, so a deep payload would exhaust the stack before any cap applied), the id grammar
(the id is also the filename, so this is the path-traversal guard) plus a containment check at the
write, schema parse, delimiter neutralization of every attacker-reachable string, removal of every
`agent`-path action — a bundle contributes layout, never behaviour — then a re-parse. The stored
Template carries `untrusted:<source>`, which flows into the Surface's content origin, and from there
into the origin of the Event log entry an Atom action produces: without that, an imported Template's
text would reach the Agent's context laundered as something the user typed. A Template _derived_ from
such a Surface inherits the untrusted origin too, so an import cannot be re-harvested clean.

That same discipline covers the Template's own bookkeeping, not only the Surfaces built from it. Every
`template.saved` and `template.reused` Event log entry carries the Template's own (possibly untrusted)
origin rather than a hardcoded `trusted:system` or the turn's write origin alone — an imported bundle's
provenance must survive being saved or reused exactly as it survives being instantiated. Both events
interpolate attacker-reachable text (the Template's `name`, the source Surface's `title`), so both pass
it through the same delimiter neutralization and a bounded truncation before it reaches the Event log,
the way the pin event's own title already did. `list_templates` observes the mirror rule on the read
side: an entry whose provenance is untrusted renders inside `untrustedDataBlock`'s spotlighted envelope,
the same one every other untrusted read path in this daemon uses, so an imported Template's `name`,
`intent`, `signature` and `dataProps` cannot be mistaken for instructions merely because they came back
from a tool call instead of an ingested event. A trusted entry keeps the plain rendering.

Two residual windows are accepted deliberately rather than engineered away. A Template file is
created exclusively (`O_EXCL`, and `O_NOFOLLOW` where the platform has it) so an import can never
overwrite a file it did not create, but an _ordinary_ save — a later pin or harvest — may still write
the same id afterwards: ids are derived from the intent and the tree, so a collision there means the
same composition captured for the same purpose, not a different Template being lost. And a rollback
deletes the files the failed import wrote while its `template.imported` Event log entries stay: the
Event log is append-only (ADR-0003), and a visible trail of an import that was rolled back is worth
more than a silent one.

Of ADR-0010's migration discipline this import keeps preview-first (nothing is written without an
explicit apply, and the plan lists every surviving prop value), refusal with the exact next command
instead of a silent skip, an exclusive lock held across preflight and writes, and staged writes rolled
back if a later one fails. It deliberately does not replicate that importer's encrypted backup, marker
file, secret allowlist or ownership repair: those exist because the legacy importer rewrites the
most-injected files an installation has and can leave a half-migrated state, while a template import
only ever creates new files under a Space's `templates/`, refuses on any collision, and is undone by
removing the file the CLI just named.

## Content origin follows the Surface, not just the moment it was created

`content_origin` is not fixed at creation: every patch — state or tree, not only a tree-changing one —
recomputes it as the least-trusted of the Surface's own stored value and that write's own origin, since
an untrusted state patch can carry attacker text into the Surface just as an untrusted tree patch can.
`enqueueAgentAction`'s Event log entry derives its origin from this same stored value, so a Surface
built from an imported Template can never hand the Agent laundered text merely because a later patch
happened to touch only its state. Provenance also records which Space a reused Template lives in, not
only its id: a Template's id is unique only within its own Space, so the id alone cannot say where a
reused Surface's Template actually came from — two Spaces can each hold one with the same id.

## Boot reconciliation and preview fidelity

A Tree proposal the human accepted but that never actually got applied — the daemon restarting between
resolving the proposal and the `patchTree` call that applies it — is reconciled at boot, the same
repair-on-start discipline the trust layer's own admin Surfaces already run. And the preview a pinned
Surface's Tree proposal shows is not merely "which Atom types moved": it lists the human-visible props,
bindings and declared actions a changed subtree carries, because the Atom type alone is not always the
substantive change a human is being asked to approve.

## Consequences

- `Surface` gains `pinned` and `pinnable`, both defaulted, and the Gateway gains a replayable
  `surface.pinned` event: pin membership and pinned order are state every client must converge on,
  not something a later GET happens to reveal or each browser may order independently.
- Per-Space Surface ordering moves from a PWA-local preference to Gateway-owned pinned and regular
  groups; snapshots, replay, and live updates expose one authoritative arrangement.
- Daemon-owned Surfaces and the projected FACTS Surface are `pinnable: false`; the client never offers
  a toggle the daemon would refuse.
- The Agent-facing tools (`list_templates`, `create_surface_from_template`, `pin_surface`, and the
  justification gate on `create_surface`) ship as a tested seam: this daemon still has no live Agent
  loop to hand a `ToolDef[]` to, exactly as `search_memory` shipped in
  [issue 021](../../issues/021-advanced-memory.md). What runs live is the engine, the pin route, the
  pin event and the proposal lifecycle.
- Templates are files under the Space (`templates/<id>.json`), so they follow
  [ADR-0006](0006-file-based-memory.md): the files are the truth, a merge carries them across, and
  nothing needs an index to find them.
