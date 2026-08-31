# Disposable hybrid index: files stay the truth, the index only makes them findable

For each Space, a SQLite FTS5 index (`memory.sqlite`) over the Event log and `FACTS.md` makes the
long tail searchable without ever becoming an answer. It is **disposable**: deleting it is a
supported recovery, `memory-index rebuild` reconstructs it from the files, and the same queries
return the same hits in the same order. Nothing the index holds is the truth — it stores a stable
source reference, times, an origin and a validation hash, and the searchable text; the answer is
always re-read from the file the reference points at. This is what "extraction at most _indexes_"
from [ADR-0006](0006-file-based-memory.md) means in practice, and it keeps
[ARCHITECTURE.md §7](../../ARCHITECTURE.md)'s ban on extraction-as-truth structural rather than
aspirational.

Status: accepted

Delivered by [issue 021](../../issues/021-advanced-memory.md), which also pulled forward the
minimum of [issue 032](../../issues/032-facts-hygiene-context-budget.md) that its own acceptance
criteria require. See "Relationship to issue 032" below.

## Source references and validated dereference

- An event is `event:<spaceId>/<file>#<line>`. The Event log is append-only
  ([ADR-0003](0003-declarative-atoms.md)), so file plus 1-based line is stable forever.
- A fact is `fact:<spaceId>/<recordId>`, where `recordId` is a hash of the record's **persisted
  identity line** — its text, its `noted` date after the write-time fallback, and its origin _as
  written to disk_ — plus a document-order ordinal when that line repeats.

Three things forced that shape, and each of them broke a simpler idea first:

1. `FACTS.md` is rewritten on every write, so position cannot be an identity.
2. Normalized text cannot be an identity either. The Curator's comparison key strips everything
   outside `[\p{L}\p{N}]`, and before this issue it stripped everything outside `[a-z0-9]` — under
   which every fact written in a non-Latin script normalized to the _same empty key_. That was
   already a live defect: such facts superseded each other. `wordsIn` is now Unicode-aware, but a
   comparison key remains the wrong thing to identify a record by.
3. Hashing the in-memory record is not enough either, because `formatFact` deliberately does not
   persist a _trusted_ origin (absent means trusted). An id computed from an in-memory
   `trusted:system` could never be reproduced by reading the file back, so the hash is taken over
   what the file will actually contain.

The state metadata (`dormant:`, `superseded:`, `by:`) is excluded from the identity, so a record's
identity _hash_ is unchanged as it moves between sections. The `-<n>` ordinal is positional, so two
byte-identical records can swap ordinals if their document order changes — which is why the ordinal
only ever distinguishes records that are indistinguishable anyway. A record with no `noted` acquires the fallback date on
its first rewrite and its id changes once, then never again; FACTS is reindexed wholesale on every
write, so the index follows, and a reference captured earlier degrades to `missing` — never to a
different record.

**Dereference always validates.** An event's raw line must match the stored sha256; a fact's
recomputed id must still be present. A mismatch reports `stale` and the hit is dropped from the
answer. Returning a wrong record would be worse than returning none: the whole point of keeping
files as the truth is that a retrieved claim carries the provenance it was written with.

Where the same id appears in more than one section — possible for byte-identical records — active
wins over dormant, which wins over superseded.

## Reconciliation, and why per-hit validation is not enough

Validation catches a hit that has gone bad. It cannot catch a record the index never learned
about, because a missing candidate simply never matches and so never produces a hit to repair.
Reconciliation therefore walks the complete inventory, in both directions, at every boot:

- A log file with no cursor is indexed whole.
- A file shorter than its cursor cannot be a legitimate append-only log, so it is reindexed whole.
- A file whose indexed prefix no longer hashes to the stored `prefix_hash` is reindexed whole. This
  is the case a size comparison cannot see: a restored file replaced with different content at the
  same length.
- Otherwise the tail is indexed from the cursor.
- `FACTS.md` is reindexed wholesale. It is bounded by design, which is what the budget below is
  for, so this is cheaper than cursor bookkeeping over a file that gets rewritten.
- Records and cursors whose Space or log file is gone are pruned, as are records describing lines
  beyond a file's current length — an index restored _ahead_ of the files.

Records, FTS rows and the cursor advance inside one transaction. A cursor committed without its
rows would hide the gap from every later reconcile, since nothing would ever look at those bytes
again.

A schema-version mismatch drops everything and rebuilds. That is a legitimate substitute for a
migration framework precisely because the index is disposable.

**Known limit.** Corruption of a `hash` value _inside the database_, with the files unchanged, is
not self-healed: the cursor still matches, so reconciliation sees nothing wrong, and that reference
stays unresolvable. The behaviour is safe — the affected hit is excluded, never answered wrongly —
and the recovery is `pnpm --filter @veduta/daemon memory-index rebuild`. Self-healing at row
granularity was considered and rejected as an extra code path for a scenario that requires database
corruption without file corruption.

## Determinism

Acceptance requires that a deleted index rebuild to identical hit ids **in identical order**. Two
things make that true: every ordering ends in `source_ref`, so it is total and never depends on
insertion order or `rowid`; and the order is explicit rather than implied —

- `relevance`: bm25 ascending (FTS5 scores are negative, so ascending is best-first), then the
  clock descending, then the reference.
- `recency`: the clock descending, then bm25, then the reference.

The **clock** is `coalesce(occurred_at, recorded_at)` under the default `effective` time basis and
`recorded_at` under `recorded`, and the _same_ expression drives both the range filter and the
recency sort. Otherwise "most recent" would quietly mean a different clock from "in this range".
Every indexed timestamp is normalized to a single ISO instant, because range filters compare these
strings lexically and an imported or hand-written line may carry an offset like `+02:00`.

## Time-aware retrieval

The query's date range is extracted first, in the user's timezone, and the matched phrase is
**removed from the search terms**: the words "start of June" must not have to appear in a record for
that record to match. This is LongMemEval's time-aware query expansion, the highest measured gain
in the memory literature ([ref. 06](../references/06-memory-research.md)).

The timezone is global configuration (`memory.json`), not a property of a Space: a Space is a life
area, not a locale. It also anchors the nightly Reflection, so "04:00" is the user's 04:00 rather
than the deployment's — which is why `nextCronOccurrence` gained an optional zone, with an explicit
policy for the two ways a local time fails to name exactly one instant: a spring-forward time that
does not exist runs at the transition instant, and an ambiguous fall-back hour runs once, at the
earlier one.

## Fact augmentation, named

The index makes an event findable by its type, its text, **and every string leaf of its payload**,
all attributed to the original log line's reference. The case that matters, and the one the spec's
"fact-augmented" language points at, is a `reader.summary` event: its payload holds the quarantined
reader's schema-validated extraction — sender, subject, entities, deadlines, urgency, intent,
summary — so that extraction is what makes the line findable, while the line itself remains the
answer. The rule is deliberately the general one rather than a special case for that event type:
any structured payload a daemon subsystem writes becomes searchable the same way, with the same
guarantee, and there is no list of blessed shapes to keep in sync. The total indexed text per
record is capped so one outsized event cannot bloat the index. Nothing in the index is ever treated
as a claim.

## Embeddings

Not implemented, and deliberately so. The retrieval interface is provider-agnostic, so an optional
local embedding layer would be an additional candidate source inside `search` with no change to any
caller. Acceptance needs none of it, and the literature does not support paying for it at personal
scale ([ref. 06](../references/06-memory-research.md): "hybrid keyword+embedding + an agent that
knows how to grep = a baseline nobody convincingly beats"). Adding the abstraction before the
implementation would be unearned complexity.

## The nightly Reflection

Sleep-time compute as a visible Automation, per [ADR-0005](0005-event-driven-proactivity.md)'s rule
that proactivity is inspectable and switchable off.

- **One conservative Curator contract.** Topic proximity only narrows the search for an established
  contradiction; it never authorizes retirement on its own. Exact repeats noop, genuine
  contradictions supersede, and other topic-related facts coexist. A refinement uses
  `write_fact.supersedes` to identify the exact active fact it replaces; a stale target fails. A
  value-level heuristic was rejected because multiple values on one topic can be distinct claims.
  The Reflection uses the same contract rather than a separate mode, so every write path preserves
  the guarantee that a still-valid fact is never falsely superseded
  ([issue 034](../../issues/034-curator-false-supersede.md)).
- **Evidence, validated.** A distilled fact carries the source references it came from; each is
  kept only if it dereferences and belongs to the window being distilled. A fact left with no valid
  reference is dropped, because a claim whose evidence is not in the window it was distilled from is
  a fabrication.
- **Provenance per fact, not per window.** Each written fact takes the effective origin of _its own_
  evidence, so an untrusted-derived claim keeps its mark and still gates a later turn
  ([docs/SECURITY.md §3.2](../SECURITY.md)). A single window-wide origin would have been
  conservative but blunt.
- **Losslessness lives in the Event log.** FACTS is a read model; the log is append-only and never
  rewritten, so that is where every claim, date and origin remains recoverable. One consequence had
  to be handled explicitly: when the Curator answers `noop` because a fact is already known,
  `writeFact` appends nothing, so the Reflection appends its own `fact.evidence` entry. Without it
  the evidence trail would stop growing at the first repetition — the exact loss "lossless" forbids.
- **Idempotent occurrences.** Both `reflection.done` and `reflection.skip` are terminal and record
  `completedThrough`; a failure records neither, so the next run re-reads the window it failed on
  instead of losing it. The window is exclusive at its lower bound and excludes the Reflection's own
  housekeeping entries, or a previous run's marker would make the next window perpetually non-empty.
  The first window starts at the previous _zoned_ cron occurrence, not at "24 hours ago", which
  drops or repeats an hour across a transition.
- **Demotion has no veto and no floor.** It ranks by recency and demotes until the rendered active
  projection fits under `low`, up to and including the last active record. Demotion is not
  forgetting: the record stays on disk in `## Dormant`, stays retrievable, and every demotion is an
  Event log entry. A "never demote anything recent" rule was considered and rejected because it
  permits finishing while still over budget — the acceptance criterion failing quietly.

## Relationship to issue 032

Issue 021 depends on 032, which is still open. The minimum 021's own criteria and safety model
require was pulled forward:

- the third FACTS state `dormant` — valid, on disk, not injected, retrieved on demand;
- the `low` watermark, measured over the **rendered** active projection in UTF-16 code units,
  `O(projection length)`, no tokenizer;
- one shared projection: `projectFacts` returns the injected text, the taint origins and the rendered
  active size from a single traversal of the document, so those three can never disagree about what
  was rendered. (Context assembly and taint collection still call it separately, each on its own
  `readFacts` — the guarantee is that they cannot diverge in _what_ they compute, not that the work
  happens once per turn.)
- 032's **live-taint write rule**. Without it, 021's requirement that retrieval "grows the turn's
  live taint" would have been decorative: `write_fact` and `append_event` derived their origin from
  the turn's _start_, so a trusted turn could retrieve an untrusted dormant fact and persist a clean
  derivative that a later session would read as trustworthy. Both now read
  `ToolContext.taint.origins()` at execution time, which that field's own contract already
  required.

Left to 032, and not needed here because 021 ships no truncation of the injected set: the `high` and
`hard` watermarks and the over-cap `write_fact` error, the Unicode hard-gate, secret redaction in
`writeFact`, atomic FACTS writes, the bounded superseded tail, the human-file size warning, and the
boot migration for files already over `hard`.

## The pre-compaction flush is a seam

`ContextPolicyContext` gained a `beforeCompact` callback: a policy that compresses a session must
await it and must not compact if it rejects. The flush decorator **fails closed** — a failed flush
means the turn continues uncompressed — because compacting after failing to persist what a session
holds destroys exactly that content, which is the destructive forgetting ARCHITECTURE.md §7 forbids.

The mechanism is worth stating precisely, because an earlier draft of this document claimed more
than the code delivered. `beforeCompact` runs _inside_ the policy's `transform`, so the decorator
cannot abort a transform already under way; what it can do is refuse to return its result. So the
decorator waits for the flush's outcome after `transform` settles — no matter what the policy did
with the rejection, including swallowing it or never awaiting it — and discards the policy's output
whenever the flush failed. The guarantee does not depend on the policy honouring the contract, only
on the decorator owning the return value.

The hook was put on the context rather than added as a second `willCompact()` predicate on the
policy: two methods that must independently reach the same compact-or-not conclusion can disagree.

This repo contains no compaction policy — the daemon runs `disabledContextPolicy` deliberately — so
the flush is a wired and tested seam, not live behaviour. Building a session-compaction policy is a
separate product decision and is not among issue 021's tasks. It is not wired into `server.ts`, and
this is stated rather than implied.

## Considered options

- **A single SQLite file shared with Surfaces or the scheduler**: rejected. Deleting the index must
  be a supported recovery, and it must not take Automations or Surfaces with it.
- **Storing the record's text in the index and answering from it**: rejected — that is
  extraction-as-truth, and it loses provenance
  ([ADR-0006](0006-file-based-memory.md), [ref. 06](../references/06-memory-research.md)).
- **An id persisted into `FACTS.md` as extra metadata**: rejected as unnecessary once the identity
  is derived from the persisted line — no file-format change, no counter, no randomness.
- **Detecting a changed log file by size or mtime**: rejected. A restored file can differ at the
  same length, and a restore can preserve mtime.
- **Driving reconciliation from failed hits**: rejected. It cannot see a missing candidate, which is
  the failure that matters.
- **Embeddings on by default**: rejected for now — see above.
