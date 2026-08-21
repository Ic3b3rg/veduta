# 128 — Sanitize forbidden Unicode at durable memory boundaries

## Parent

#32

Repository specification:
[issues/128-sanitize-forbidden-unicode.md](https://github.com/Ic3b3rg/veduta/blob/main/issues/128-sanitize-forbidden-unicode.md)

## What to build

Create one shared sanitizer for the exact injection-corpus Unicode characters that Veduta forbids
in durable memory. Move the existing quarantined-reader behavior behind that module and use it at
the central Event persistence boundary before secret redaction or indexing.

The sanitizer removes U+200B, U+200E–U+200F, U+FEFF, U+2028–U+2029, U+202A–U+202E,
U+2066–U+2069, and U+E0000–U+E007F. It must preserve the legitimate joiners U+200C and U+200D.
Apply it deeply to every string field, payload leaf, and payload key on every Event append path. If
sanitizing keys creates a collision, reject the append explicitly rather than overwriting data;
reject required text that becomes empty.

Legacy append-only Event logs remain immutable. Sanitize their content when rendering or indexing
it, and retain the original provenance. Expose the same sanitizer for the FACTS persistence
boundary introduced by the dependent ticket; do not create competing character lists or
normalization paths.

## Acceptance criteria

- [ ] One shared module defines and tests the exact forbidden code-point set, while U+200C and
      U+200D round-trip unchanged.
- [ ] Every new Event is sanitized before redaction across top-level strings, nested arrays/objects,
      payload leaves, and payload keys.
- [ ] A key collision caused by sanitization rejects the whole append with an explicit error and
      persists nothing.
- [ ] Required Event text that becomes empty is rejected; other cleaned writes continue without
      invisible characters.
- [ ] Legacy Event content is sanitized at render/index time without rewriting the append-only log
      or changing provenance.
- [ ] Hidden-character-split credential shapes are joined before the existing Event redactor
      evaluates them.
- [ ] Focused unit and persistence-boundary tests cover all write paths and nested payloads, and
      `pnpm check` passes.

## Blocked by

None — builds on completed issues #6 and #21.
