# ClawHub inspection-only Chat proof

Observed on 2026-10-05 for [#183](https://github.com/Ic3b3rg/veduta/issues/183), under
[ADR-0032](../adr/0032-reviewed-extension-hub.md). Host: Darwin arm64. This proves
read-only package inspection, not dependency installation, activation or complete
advertised package behavior.

## Observed public-catalog browser proof

A fresh loopback Gateway and built PWA used the normal Chat, AgentRunner, tool
registry and durable Chat timeline. Inference used the built-in mock provider;
catalog/version/download requests used the real public ClawHub endpoints, without
an injected catalog transport or executing package code.

| Exact source                                                                                         | Observed identity and result                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [steipete/obsidian v1.0.0](https://clawhub.ai/steipete/obsidian?version=1.0.0)                       | Three downloaded files; archive SHA-256 `ff964e127170088a5e5e280f9f437afcba3a6e3d579c05b947a37b7f4253bf1b`; Adaptation required. The report showed the published `obsidian-cli` dependency, maintained `notesmd-cli` rename, Gateway vault/desktop requirements, permission limits, scan warnings and provenance gaps. |
| [pskoett/self-improving-agent v4.0.2](https://clawhub.ai/pskoett/self-improving-agent?version=4.0.2) | Sixteen downloaded files; archive SHA-256 `89f2a239f9d675c4c5787cf61c17f709cd38cb9c7d395f9dc50f487a59a47291`; Unsupported. The report inventoried foreign lifecycle hooks, session APIs/cross-session authority, Node/Bash runtime requirements, transcript and learning-file access.                                  |

Each report contained the publisher, exact version, source, archive and normalized
inventory hashes, complete file paths/sizes/hashes, scans and their limits,
dependency/setup declarations, required tools, data access, execution host and
permissions. Both remained complete after browser reload. The Gateway made no
installation or permission grant. The disposable Gateway was stopped and its
data removed; the existing user installation was not modified or restarted.

The collaborative preview's snapshot operation was unavailable during this run.
Its navigation, input and page-evaluation tools exercised the real UI and read
the rendered reports. Screenshots are therefore not claimed as evidence.

## Controlled behavior and recovery proof

The committed pinned public fixtures independently establish exact archive/file
identities. The clean-data Chromium journey requests a bare owner-qualified
identifier inside normal Chat wording and the pinned hook package, checks complete
reports and unchanged Service connections, reloads, restarts the Gateway on the
same data root, and checks durable reports without new catalog reads. It then
exercises an invalid link and an unavailable catalog, including error-body
non-disclosure and persistence after refresh. That journey passed.

Focused tests cover identity/version preservation, standard link wrappers,
current-request binding, changed scanner metadata and file bytes, cancellation,
redirect/status/missing-version/malformed/oversized failures, bounded ZIP parsing
and the exact published requirements. A hostile model fixture claims installation
and attempts inspection while a command tool exists: the turn offers only
inspection and displays the complete Gateway-derived report, with no command or
model success prose. This is controlled inference/error evidence, distinct from
the real catalog reads above.

Two independent review axes were used. Standards review found no documented rule
violations and two nonblocking maintainability suggestions. Spec review found
and verified fixes for source detection, discarded scan metadata and missing
foreign requirements; no P1/P2 findings remained in the final reviewed snapshot.
Relevant unit tests, the clean-data browser E2E and `pnpm check` passed.

## Manual PWA reproduction

1. Open Home in a fresh development instance and send
   `Inspect https://clawhub.ai/steipete/obsidian?version=1.0.0` in Chat. Read the
   complete report, stale dependency explanation, exact identity and inspection-only
   status. No installation/approval prompt should appear.
2. Send `Install steipete/obsidian@1.0.0`. It must still perform only inspection.
   Repeat with a Markdown link or angle-wrapped ClawHub link.
3. Send `Inspect @pskoett/self-improving-agent@4.0.2`. Verify Unsupported and the
   foreign hook/session tools, runtime dependencies, transcript and learning-file
   access in its report.
4. Reload Home, leave and return to the same Chat scope, and reconnect after a
   Gateway restart. Existing reports must remain without silently installing or
   granting anything.
5. Send `Inspect https://clawhub.ai/steipete/obsidian?url=https://evil.test` and
   `Inspect @steipete/obsidian@1.0.0+unpublished`. Expect a closed refusal rather
   than inspection of another version, an external redirect, or a running turn
   that never ends. A genuinely unavailable catalog must likewise produce an
   explicit refusal; its raw error body must not appear.
