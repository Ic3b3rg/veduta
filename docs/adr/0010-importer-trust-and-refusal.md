# Imported legacy memory is untrusted; the importer refuses rather than skips

Material imported from another personal agent (OpenClaw, Hermes) enters as **untrusted content**. Every fact and Event log entry written by the importer carries `untrusted:openclaw` / `untrusted:hermes`, so it renders inside the delimited untrusted block and keeps gating L1+ actions for as long as it lives (ADR-0007). The imported `USER.md` profile is written wrapped in that same block, because it is injected verbatim into every context. `SOUL.md` is the one artifact that cannot be delimited — it _is_ instructions — so it gets the other defenses instead: Veduta's invariants are written first as the authoritative block, the imported personality follows under a heading stating it does not override them, delimiter tokens are neutralized, the full adapted text appears in the preview before anything is written, and the injection corpus carries imported-SOUL cases.

The import itself follows the Hermes migration discipline (`docs/references/04-onboarding-migration.md` §C): dry-run is the default and is genuinely read-only; an atomic encrypted backup precedes every mutation; secrets are limited to a three-key allowlist behind an explicit flag and are reported by name only; a conflict or an already-migrated installation is a **refusal with the exact next command**, never a silent skip; unmapped material is archived redacted, with a generated `NOTES.md` listing what must be recreated by hand.

Rationale: `MEMORY.md` and daily notes were written by _another agent_ that read the open web and the user's mail — they are not something the user typed, so treating them as trusted would launder attacker-controlled text straight into the most-injected surfaces we have (FACTS, USER, SOUL). Silently skipping a conflict is how a migration produces a half-imported installation nobody can reason about; refusing is recoverable, a partial state is not.

Status: accepted

## The four invariants the code is shaped around

Recorded here because they are not derivable from the issue: each one exists because the obvious implementation gets it wrong.

1. **The dry run is read-only by construction, not by intention.** Reading the target's state must never construct a `SpacesEngine` — its constructor runs `ensureBaseLayout` and creates `spaces/`, `USER.md` and `SOUL.md` on the spot, so a "preview" built that way writes files. `readTargetState` uses plain `fs` reads, and `new SpacesEngine` appears exactly once in the importer: inside the lock, after the backup.
2. **Preview and apply take the same options and produce the same plan.** Both accept `{source, overwrite, secrets}`, and apply recomputes the plan rather than trusting one handed to it — so what the preview described is what runs. Toggling an option in the wizard re-previews before apply is offered again.
3. **One writer, marker last.** Apply holds an exclusive `import.lock`, recomputes the plan _inside_ it (so two concurrent runs cannot both observe "not previously imported"), and writes its `import.json` marker only after every other mutation. A crash before the marker leaves per-item conflicts that make the retry refuse with an actionable message — the intended behaviour, not a gap.
4. **The data directory has exactly one correct owner.** When the CLI runs as root against a directory owned by someone else (the normal VPS case, since only root can read both the admin's home and `/var/lib/veduta`), it recursively `lchown`s the tree afterwards. `createBackup`, `SpacesEngine` and the vault all create paths a caller cannot enumerate, so fixing the whole tree is both simpler and more complete than tracking a path list.

## Consequences

- The `Imported` Space stays permanently tainted until the user promotes its facts elsewhere: any turn that reads it needs an approval card for outbound actions. Friction by design — it is the same rule that makes an injected email harmless.
- The `Imported` Space stretches "a Space is a life area" (`CONTEXT.md`): it is a staging area, and its `INSTRUCTIONS.md` says so rather than pretending otherwise.
- The Event log is append-only (ADR-0003), so `--overwrite` can replace `SOUL.md`/`USER.md` but never rewrites imported history: re-importing appends.
- The daemon runs under `ProtectHome=yes` and can never read the admin's home, so the installer stages **only** memory and identity files into `<dataDir>/import-source/<kind>`. Secrets are never staged, which makes the wizard's import path secret-free by construction and keeps secret import on the standalone CLI.
- The importer copies in and never modifies the source install, so a failed import is always recoverable by re-running it.
