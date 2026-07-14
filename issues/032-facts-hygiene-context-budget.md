# 032 — FACTS hygiene and context budget: dormant tier, watermarks, provenance-aware retrieval, write-path hardening

## Context

The core memory shipped in [#6](006-spaces-engine-memory.md) always injects the whole `FACTS.md` — active **and** the never-pruned `## Superseded` section — into every turn (`spaces-engine.ts` `assembleContext` → `factsForContext`). Active facts also grow unbounded. Together they are the real context-saturation vector in Veduta, and they degrade recall as context grows ("context rot", [ref. 06](../docs/references/06-memory-research.md); Anthropic context-engineering).

An adversarial cross-check (Codex GPT-5.6) of a first plan surfaced that naive truncation would break the trust model and the anti-requirements. This issue is the safe version: bound what enters context **without destructive forgetting** ([ARCHITECTURE.md §7](../ARCHITECTURE.md)), and close two pre-existing write-path security gaps the work depends on.

Comparative evidence (OpenClaw two-tier + disposable index, Hermes hard per-file budgets with deterministic error-on-overflow, Letta "filesystem 74% on LoCoMo") is consistent with keeping files as truth and bounding the injected projection. Design maps to established storage/OS patterns: FACTS is a **read model** over the Event log (event sourcing), the injected active set is a **working set** with **demand paging** of cold facts, watermarks use **hysteresis**, and Reflection is **LSM-style compaction**.

Amends [ADR-0006](../docs/adr/0006-file-based-memory.md) and [CONTEXT.md](../CONTEXT.md): FACTS gains a third, non-destructive state.

## Goal

A Space's injected FACTS projection is bounded and deterministic, no valid fact is ever lost, tainted content cannot launder its origin through a memory write, and no secret or invisible-Unicode character can land durably in FACTS or the Event log — from any write path.

## Tasks

### Dormant tier (amends ADR-0006 + CONTEXT.md)
- Add a third FACTS state: `active | dormant | superseded`. **Dormant** = valid, kept on disk, **not injected**, retrieved on demand. It is not `superseded` (not replaced) and never deleted — so it is not destructive forgetting.
- `factsForContext`/`assembleContext` inject only the **hot active set** plus a bounded tail of recent supersessions; dormant and older superseded stay on disk.
- Amend `docs/adr/0006-file-based-memory.md` and the FACTS entry in `CONTEXT.md` to define the dormant state and the working-set/demand-paging model.

### Context budget (watermarks + backstop) — FACTS only
- Two watermarks with hysteresis over the **rendered** active projection (facts + dates + origin labels + spotlighting wrappers, not raw text): `low` (target after compaction) / `high` (marks a pending Reflection) / `hard` (backstop). Defaults, tunable: low ~4000 / high ~6000 / hard ~8000 characters. Define the unit explicitly (UTF-16 code units) and calibrate against the rendered projection.
- Over `high`: flag a pending Reflection ([#21](021-advanced-memory.md) demotes least-relevant valid facts to dormant — the escape valve that makes rejection rare). Between reflections the set may exceed `high`; it must never silently drop injected facts.
- Over `hard`: `write_fact` returns an explicit tool error (never truncates the injected copy).
- Bounded superseded tail: entry-count limit **and** rendered-character limit, complete entries only, with an omission marker. Fixed count is advisory "recent changes", **not** contradiction protection (see below).
- Non-blocking size **warning** (no enforcement, no compaction) on the human-authored `USER.md` / `SOUL.md` / `INSTRUCTIONS.md` past a recommended size (~2000 chars); define delivery + dedup so it does not spam every context assembly.
- Boot/restore migration for FACTS files already over `hard`: audit at load, persistent user-visible warning, allow Noop and size-reducing writes while over cap, flag excess for demotion to dormant on the next Reflection.

### Provenance-aware FACTS retrieval (the recovery path — must ship with the truncation)
- A `search_facts`-style retrieval over active + dormant + superseded that **dereferences the original FACTS record**, returns its origins, and **grows the turn's live taint** on every hit. Truncation of the injected superseded set is only safe once this exists.
- Rendering and origin selection go through **one shared projection** so what is injected and what taints the turn cannot diverge.

### Write-path security hardening (pre-existing gaps this work depends on)
- **Live-taint into writes**: `write_fact` and `append_event` must derive their write origin from the live taint accumulator at execution time (conservatively pick an untrusted origin when present), not the origin fixed at turn start. Prevents laundering an `untrusted:*` fact into a `trusted:system` record readable clean next session.
- **Secret redaction in `writeFact`**: reach parity with `appendEvent` — reject/redact recognized credentials before Curator comparison and persistence, with a user-visible explanation. Covers plain and hidden-character-split key shapes.
- **Unicode hard-gate at a central persistence boundary, before redaction**: extract the quarantined-reader's `stripHiddenChars` into a shared module and apply it at persistence for FACTS **and** every Event log field/payload leaf and key (deep traversal), routing every FACTS rewrite (including `mergeSpaces`) through one validated helper. Ordering matters: strip hidden characters before secret redaction so `sk-<zero-width>...` cannot evade the regex. Specify exactly which code points are forbidden and whether writes reject or transform; **preserve** legitimate joiners (ZWNJ/ZWJ U+200C/U+200D) needed for Persian/Indic/emoji. Claim: "injection-corpus characters never persist", not "all invisible Unicode eliminated". For legacy append-only logs, sanitize at render/index time (never rewrite provenance).
- **Atomic FACTS writes**: replace `writeFileSync` truncation with the existing tmp/fsync/rename helper (`backup.ts`) to survive crashes during rewrites.
- **Event context guard**: a rendered-size cap on automatic Event log context and on memory-tool results, so one giant event cannot defeat the FACTS budget.

## Acceptance criteria

- A Space with 100 superseded facts injects only the active hot set + the bounded tail (count + rendered-char capped); the rest is on disk and reachable via `search_facts`.
- No `injection-corpus` invisible character ever lands in `FACTS.md` or the Event log, from any write path (`write_fact`, `append_event` incl. nested payload, `mergeSpaces`); a recognized secret is never persisted into FACTS.
- Hidden-untrusted-fact → `search_facts` retrieval → `write_fact`/`append_event` → a fresh session still sees the derived fact as tainted (end-to-end test); the taint of a **non-injected** dormant/superseded fact does not gate the turn, while injected-tail and retrieved facts do.
- Over `hard`, `write_fact` returns an explicit error and never truncates the injected copy; a size-reducing update and Noop are still accepted over cap; a pre-existing over-cap file boots with a warning and stays functional.
- Budget check measures the rendered projection and is sub-millisecond (O(projection length), no tokenizer); boundary tests cover exactly-hard, hard+1, Noop, size-reducing update, pre-existing over-cap, one huge superseded entry, nested event payloads, and read→write mid-turn taint.

## Dependencies

006. (Enables the budget compaction in 021, which demotes valid facts to dormant; 021 depends on this issue.)
