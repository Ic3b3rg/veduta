# Codex 0.160.0 local state

Source review for [#118](https://github.com/Ic3b3rg/veduta/issues/118), 2026-10-12.
The official `rust-v0.160.0` annotated tag resolves to
`a956835d020762cb2b570053af06f643a11c0ecc`. These observations concern that exact
source; they do not imply compatibility with newer database layouts.

## Persistence and ownership

Ephemeral session creation skips both the rollout writer and thread state context.
The upstream app-server test verifies a pathless ephemeral thread. Veduta explicitly
sets `ephemeral: true` for each inference thread and retains its canonical history
in its own SessionStore and Space Events. Sources:
[session creation](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/session/session.rs#L1007),
[state context](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/core/src/session/session.rs#L1111),
[ephemeral regression](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/app-server/tests/suite/v2/thread_start.rs#L1104).

The recognized history files are `history.jsonl`, `session_index.jsonl` and its
`.tmp` rewrite, plus rollouts inside `sessions/` and `archived_sessions/`, directly
or beneath year/month/day directories. A rollout is
`rollout-YYYY-MM-DDTHH-MM-SS-<thread UUID>[_<rollout UUID>].jsonl`, optionally `.zst`.
Interrupted decompression appends `.decompress.<pid>.<counter>.tmp`; compression
uses `rollout-compress-<random>.tmp`. Unknown entries are retained rather than
recursively guessed at. Sources:
[roots](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/rollout/src/lib.rs#L86),
[filename grammar](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/rollout/src/rollout_file_name.rs),
[temporary paths](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/rollout/src/compression.rs#L1399),
[compression temporary files](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/rollout/src/compression.rs#L850),
[index](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/rollout/src/session_index.rs),
[message history](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/message-history/src/lib.rs).

The [database definitions](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/state/src/sqlite.rs)
name `state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite`,
`memories_v2_1.sqlite`, `queue_1.sqlite` and `thread_history_1.sqlite`.
Their migrations are respectively `migrations`, `logs_migrations`,
`goals_migrations`, `memory_migrations` (both memory variants), `queue_migrations`
and `thread_history_migrations` beneath `codex-rs/state/`.

The main database mixes thread content with operational state. Preserve
`remote_control_enrollments`, historical `device_key_bindings`, projects, roots,
project idempotency keys, external configuration imports and migration bookkeeping.
Delete only the explicitly enumerated thread, log, queue, goal, memory and agent-job
content tables in `codex-local-state.ts`. Historical migration prefixes are supported;
for example, goals and memories once lived in the main database. Whole-database
unlinking would erase unrelated state. Sources:
[main migrations](https://github.com/openai/codex/tree/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/state/migrations),
[thread-related deletion](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/state/src/runtime/threads.rs#L1155).

The default [credential backend](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/config/src/types.rs#L112)
is File; [auth.json](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/login/src/auth/storage.rs#L153)
is credential material. Legacy cleanup leaves it byte-for-byte unchanged, including
permissions. Full connection removal intentionally deletes the entire owned home.

## Schema recognition

`codex-state-schemas.ts` records SHA-256 fingerprints after each migration prefix
of the pinned source. To reproduce, execute each directory's SQL files in sorted
filename order against an empty SQLite database. After each file, select
`type,name,tbl_name,sql` from `sqlite_schema`, excluding names beginning with
`sqlite_` and the exact `_sqlx_migrations` name, sorted by `type,name`. Exclude null SQL,
trim and collapse SQL whitespace to a single space, serialize the rows as compact
JSON arrays and hash the UTF-8 bytes. Record each distinct digest and each filename's
numeric migration version. Internal SQLite metadata and autoindexes do not enter
the fingerprint. The source-derived final main schema fixture tests actual mixed
credential/history preservation; its Apache-2.0 license accompanies the fixture.

Cleanup preflights recognized stores before deleting any files or rows. SQLite
read-only connections can still create or modify WAL sidecars, so schema inspection
opens only a private copy of the database plus any WAL and rollback journal. Shared
memory is reconstructed inside that copy. A change in source file identity, size or
modification metadata during copying refuses inspection for a later retry. Temporary
copies are removed on success and failure; backup inspection keeps them inside its
private staging directory, respecting the configured backup working filesystem. Unknown
filenames, schemas, unsuccessful or unknown SQLx migration versions, and symbolic
links in recognized paths refuse cleanup. SQLx bookkeeping is retained. A refused
home remains unavailable through the existing Model connection error boundary;
other Gateway features remain available. Repair the affected layout against this
reviewed source and retry. Do not delete ambiguous data to bypass the refusal.

## Ordering and backups

Cleanup runs before a child's first acquisition and during boot. Each recognized
SQLite store deletes its history tables transactionally, then compacts and checkpoints
to remove retained plaintext from free pages/WAL. The policy applies only to quiescent
owned homes or private staged snapshots. It never follows configured paths outside
the validated per-connection home.

Backup snapshots nested Codex SQLite stores through `VACUUM INTO`, retaining committed
WAL data, then applies the same cleanup to the private staging tree. Live Codex files
are unchanged. Unknown schemas abort backup rather than include ambiguous history.
Veduta's canonical ledger, encrypted archive format and active credential treatment
remain unchanged; this is not a canonical conversation-retention migration.

Per-connection removal retires acquisition before waiting on the registry queue,
interrupts active/pending work and waits for child closure. Best-effort logout uses
only an existing idle transport; a missing binary or failed provider logout cannot
prevent local erasure. SIGTERM escalates to SIGKILL after one second; failure to
observe closure after five seconds refuses directory deletion. Pending creation
settlement has a 70-second bound. The registry records revoked state before erasure;
a failed termination or filesystem operation leaves a retryable record. The exact
revoked pending-removal reason is a persisted compatibility marker: catalog, refresh
and reauthorization refuse it across restart, and stale call failures cannot replace
it. This uses the existing strict configuration format without adding a new field. It removes
the record only after directory erasure, so persistence failure cannot silently
re-enable a retired live child. This follows the ownership principle in upstream
[thread deletion](https://github.com/openai/codex/blob/a956835d020762cb2b570053af06f643a11c0ecc/codex-rs/thread-store/src/local/delete_thread.rs).

Real-account retention proof is distinct from the deterministic fixtures. Follow
[the Model connection smoke procedure](11-model-connections-manual-smoke.md); do not
infer a new authorized-account result from fixture credentials or upstream source.
