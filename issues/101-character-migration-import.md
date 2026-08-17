# 101 — Migrate legacy and imported character without guessing

## Parent

- #99

## What to build

Complete the character-boundary transition for upgrading and importing users without classifying
their prose. Existing `SOUL.md` and `INSTRUCTIONS.md` files must lose only exact recognized
Veduta-owned legacy blocks through an atomic, idempotent migration. OpenClaw and Hermes imports must
continue to preserve and preview adapted personality while no longer embedding Veduta policy inside
the imported identity.

After this ticket, every persisted character document is safe to replace through the later chat
workflow without risking deletion of product invariants.

## Acceptance criteria

- [ ] Upgrade migration removes every known byte-for-byte legacy Veduta-owned character-file block
      and template, including untouched historical defaults.
- [ ] Unknown, reordered, edited, or near-match prose is preserved verbatim; migration performs no
      model call and makes no probabilistic deletion.
- [ ] Migration writes are atomic, survive interruption without a partial document, and are
      idempotent on restart.
- [ ] A customized document containing an exact known block plus surrounding user prose loses only
      the recognized block and preserves the surrounding bytes and order.
- [ ] Legacy default detection and importer conflict detection continue to distinguish untouched
      identity from user customization across the data-version transition.
- [ ] Imported OpenClaw and Hermes identity retains the existing adaptation, secret-redaction,
      delimiter-neutralization, conflict refusal, full preview, and restorable-backup guarantees.
- [ ] Imported identity is no longer prefixed with Gateway-owned rules, while the assembled prompt
      still makes those rules authoritative outside the import's write boundary.
- [ ] Re-import and overwrite paths never duplicate product policy or silently discard customized
      identity.
- [ ] Migration and importer tests cover untouched defaults, each known block independently,
      customized surroundings, near matches, empty files, repeat execution, refusal, and backup
      recovery.
- [ ] `pnpm check` passes.

## Blocked by

- #100
