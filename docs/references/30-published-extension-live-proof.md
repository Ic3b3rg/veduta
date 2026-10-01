# Published extension proof — 2026-10-01

This completes the disposable validation of the two hard examples in
[issue #177](https://github.com/Ic3b3rg/veduta/issues/177), against the execution and review contract
in [ADR-0032](../adr/0032-reviewed-extension-hub.md). These are live **original-package and
dependency** probes, not a working Hub, foreign-host adapter, or Verified listing. No package was
installed in Veduta, Homebrew, OpenClaw, or the user's vault. The original artifacts remain blocked
for the concrete reasons below. Their later Veduta ports must satisfy #185 and #187 in full.

The [immutable evidence manifest](extension-proof-2026-10-01.json) records download URLs, archive
digests, every published file with its size and digest, and the tested dependency binary/source
identity. Versioned ClawHub archives were downloaded again on this date: both matched the
2026-09-30 digests in [candidate evidence](28-extension-candidate-evidence.md). Extraction checked
package-relative paths, links, and bounded file sizes before any execution. Only inspected support
code ran, with invented notes, transcripts, and learning records in disposable directories.

## Obsidian v1.0.0 — dependency and host mismatch reproduced

Publisher: `steipete`; required binary and formula in the exact published `SKILL.md` are
`obsidian-cli` and `yakitrak/yakitrak/obsidian-cli`. The maintained project documents a
[rename to notesmd-cli](https://github.com/Yakitrak/notesmd-cli/blob/58830c82327b8b34f8e5d52e5a3a7cfa0ad0ab5a/MIGRATION.md).
The [v0.3.7 release](https://github.com/Yakitrak/notesmd-cli/releases/tag/v0.3.7) was tested as a
review candidate for dependency substitution, **not** silently treated as the requested binary.
The Darwin universal archive digest is
`b657c8b19c5fb6524136b3c47c10c3febffa9e48e8253313ea9f6f6fc32d6c72`;
the executable digest and pinned source commit are in the manifest. Its source license is MIT.
The published Skill archive has no license file; distribution permission must be established in
the Hub review rather than inferred from that dependency's license.

The dependency's Go source, dependency manifests (`go.mod` and `go.sum`), filesystem operations,
registry/default resolution, search, link rewriting, and desktop URI execution were inspected
before the binary ran. The direct dependency versions are pinned in the source's
[`go.mod`](https://github.com/Yakitrak/notesmd-cli/blob/58830c82327b8b34f8e5d52e5a3a7cfa0ad0ab5a/go.mod).
No dependency installation or shell command from the downloaded Skill was executed. The binary
ran by absolute path with a disposable child HOME/config directory and a PATH containing no
desktop opener. This made desktop opening unavailable without intercepting or mocking it, and
prevented reads of the user's real Obsidian registry. File operations required no network or secret.

| Published behavior / probe | Observed result                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binary identity            | `--version` reported `notesmd-cli version v0.3.7`; `--help` exposed its real commands. The requested `obsidian-cli` name was not installed or shimmed.                                                                                                                                                                                                      |
| Discover/default vault     | Without an Obsidian registry, `set-default DisposableVault` failed with `User config directory not found`. Running the real `add-vault <disposable path>` created a disposable registry; `set-default` and `print-default --path-only` then passed, with deprecation notices. Their modern equivalents are `set-default-vault` and `list-vaults --default`. |
| Name/content search        | The published `search "query"` failed: v0.3.7 `search` accepts no positional query and uses an interactive fuzzy finder. `list Folder` and `search-content marker` returned the invented note and line. No headless name-search parity is claimed.                                                                                                          |
| Create and read            | `create "Folder/New note" --content "Disposable marker 177" --vault <path>` wrote the expected Markdown; `print` returned it. Direct file edits remained plain Markdown.                                                                                                                                                                                    |
| Open                       | The published `create ... --open` failed with `Failed to execute Obsidian URI`, but the note already existed. A separate `print` recovered the authoritative content without re-creating or overwriting it. A missing URI handler is an unmet requirement, not successful activation.                                                                       |
| Move and links             | `move` renamed the note and updated plain and aliased wiki links plus a plain Markdown link. A Markdown target containing `%20` retained the old path when a spaced note was renamed. This concrete link-update gap must be handled or disclosed by an adapted package.                                                                                     |
| Delete                     | `delete` removed only the disposable selected note; independent reads/listing confirmed the result. Destructive scope remains a separate L2 approval in a future Veduta port.                                                                                                                                                                               |
| Restart                    | Every CLI invocation was a fresh process. Registered default-vault lookup, saved content, search, renamed paths and links survived subsequent invocations.                                                                                                                                                                                                  |
| Failure and containment    | Missing-vault access failed; `create ../outside` rejected path traversal and wrote no outside file. Registry setup recovered the default lookup failure; read-back recovered the known partial create/open outcome.                                                                                                                                         |

Reproduce after reviewing the same bytes: run the released binary by absolute path against a new
vault and new child config directory; check failure before `add-vault`, then default lookup,
`create`, `list`, `search-content`, `move`, `print`, and `delete` in separate processes. Include
plain, aliased wiki, and URL-encoded Markdown links. On a headless host, assert both the nonzero
`--open` result **and** the already-written note. Never point the probe at a real vault or register
a fake successful URI handler.

Decision: **Adaptation required** for a pinned dependency substitution and corrected recipe.
Desktop opening on a headless Gateway, or an unmounted Mac vault on a VPS, is **Unsupported**.
Neither reading Markdown nor installing a binary proves the complete advertised behavior. #185
must name the execution host and resource mount, preserve the original/adapted identities, prove
every required operation through Veduta, and show restart and truthful partial-effect recovery.

## Self-improving-agent v4.0.2 — original hook behavior reproduced

Publisher: `pskoett`; the exact archive declares an OpenClaw-only edition. Its two executable hook
files and extraction script are listed in the manifest. The tested CommonJS `handler.js` digest is
`b94261dce2de54ba6bd1d6aca48d9ef11236cbe7396bd37354daa218e0ceecf3`.
It uses Node's filesystem/path libraries without external dependencies; extraction requires Bash
and ordinary text utilities. The archive has no license file: a reviewer must resolve the
publisher's distribution license. This review did not grant permission to execute the hook in
Veduta or to let its procedural Markdown rewrite Character authority.

The **13 tests shipped in the published archive passed** with `node --test
hooks/openclaw/handler.test.js`; their temporary workspaces were removed by their teardown.
Additional invocations loaded the unchanged published handler in independent Node processes:

| Required behavior / probe       | Observed result                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opt-in                          | A `command:new` event with a disposable transcript and no `.learnings` directory wrote nothing. Creating that directory enabled the sweep.                                                                                                                                                                                                           |
| Error capture                   | `command:reset` scanned nine invented error lines and appended only five bounded, redacted excerpts. An existing `ERRORS.md` prefix was preserved. The fake token value never appeared in the saved entry.                                                                                                                                           |
| Deduplication and restart       | Another fresh process swept the same ended session with `command:new`; the saved file remained byte-for-byte unchanged. `agent:bootstrap` produced one virtual reminder reporting one pending triage entry; repeated bootstrap retained one reminder. This is exact-excerpt deduplication, not semantic recurrence folding.                          |
| Correction and feature request  | The same transcript included an invented user correction and missing-capability request. The hook did **not** create `LEARNINGS.md` or `FEATURE_REQUESTS.md`: those require the Skill's Agent-directed procedures. Error-sweep success does not prove their automatic capture.                                                                       |
| Veduta lifecycle                | Sending the proposed `beforeContextAssembly` and `afterTurnSettled` events to the unchanged hook produced no reminder or learning effect. The foreign event ABI does not implement the Veduta contract.                                                                                                                                              |
| Authority and transcript access | The disposable `SOUL.md`, `AGENTS.md`, and `TOOLS.md` were unchanged. Source inspection confirmed that promotion instructions ask the Agent to edit those files, and the hook accepts a host-provided ended-session file path. Veduta must replace both authorities with bounded summaries, scoped storage, and a Character-change Pending decision. |
| Skill extraction                | The exact `extract-skill.sh` passed dry-run and draft creation in the disposable workspace. The draft still contained TODO placeholders. A second creation refused overwrite; `--output-dir ../escape` was rejected. No draft was activated, submitted, or published.                                                                                |

Reproduction: use the published tests and independent Node invocations with a new workspace,
`.learnings/ERRORS.md` containing a sentinel, and a new session JSONL file. Exercise bootstrap,
new/reset, opt-out, duplicate sweep, redaction and over-limit input. Add user correction and
feature-request lines to prove the distinction between automatic hook capture and Agent-directed
procedures. Invoke extraction with `--dry-run`, then create once and attempt overwrite/path escape.
The host event fixtures exercise the published handler; they do not emulate a running OpenClaw
Gateway or count as successful Veduta integration.

Decision: the **original artifact is Unsupported**. A separately identified Veduta port remains
**Adaptation required** until #187 proves automatic error, correction and capability-gap capture,
deduplication and recurrence handling, opt-in/disable, bounded Space-owned storage, next-turn
reminders, reviewed promotion, draft extraction, restart, and failure/recovery through the real
Veduta host. Raw-session access, direct authority-file edits, and a second Agent loop remain
blocked. If the v1 lifecycle cannot reproduce a required behavior, the package stays Unsupported.

## Contract disposition

These observations validate the decision by exposing concrete setup, host, ABI, dependency and
partial-effect requirements. They do not lower the Hub's Verified bar. ADR-0032 still governs
inspection, per-Space grants, approval, installation, update re-review, disable/removal, review
submission, human pre-distribution approval, vulnerability response/takedown, and creator draft
testing without automatic publication. #183–#193 are the separately implementable work, linked to
#176 with unresolved blockers. #185 and #187 carry these exact full-behavior proof gates; #193
must reproduce them from fresh data and clean its persistent artifacts before release.
