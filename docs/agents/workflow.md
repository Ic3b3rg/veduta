# Working on Veduta

Use this guide when shaping a change, resuming work, accessing an external environment or
integrating a PR. [AGENTS.md](../../AGENTS.md) owns the shared rules; this file owns the workflow.

## Establish what is still needed

1. Reconcile the current request with decisions already made. For a multi-part task, keep a
   short working checklist of accepted scope, unresolved choices, completed evidence and the
   next action. Resume at that action, including after context compaction.
2. Read the relevant issue body and comments, including later decisions and linked blockers.
   Inspect the current implementation before treating a historical report as a current bug.
   Ask only if a material conflict remains after applying the user's explicit decisions.
3. Inspect branch, worktree and remote state. Isolate the change if the checkout contains
   unrelated work; reuse an existing task worktree when suitable. Preserve its owner's edits.
4. Use the skills available in this session for the job they actually cover. Historical skill
   names or an upstream workflow diagram do not create extra approval steps. If a requested
   skill is missing, check for a rename and explain the available equivalent; stop only when
   its missing capability is necessary. An explicit user approval continues to apply.

## Propose and verify the actual experience

- For a substantial interaction redesign or an explicitly requested prototype, show a reachable
  proposal and get the unresolved design choice settled before replacing production behavior.
  A routine bug fix that restores agreed behavior does not reopen the design.
- Reuse existing routes, controls, approval and mutation flows. Trace a failure through those
  boundaries before adding a special case for one Surface, Space or provider.
- Before handing over a preview, verify its exact URL, process lifetime and target device's
  reachability. Check the requested state at phone/desktop sizes as applicable, including long
  content, errors, keyboard behavior and refresh. A local browser is not a physical-device test.
- Ask about the visible behavior using a concrete example or working prototype. If the user
  does not understand the question, change the example rather than repeating its terminology.
- Reuse passing checks for unchanged code and environment. Rerun when code, dependencies, the
  integration base or relevant runtime conditions change; old branch CI does not prove a new merge.

## External access and human-only steps

- Before declaring SSH or another tool unavailable, inspect the actual local configuration,
  agent/session availability and the user's working command. Report the observed failure;
  an authentication failure alone does not establish that the environment is isolated.
- Do all authorized preparation before asking for an account login, device approval or private-key
  signature. Supply one exact current URL or command and explain the specific remaining step.
  Keep credentials and passphrases out of chat, command arguments, logs and repository files.
- After the user confirms, verify the observable result and continue. Retain confirmations of
  account settings that the local tool cannot query; ask again only if the account/context changed
  or contrary evidence exists. An expired link calls for a fresh link, not a repeated interview.
- Distinguish code publication, feed promotion and installation. Follow [RELEASING.md](../../RELEASING.md)
  for releases. If the owner reserves Apply or limits live repair, preserve that boundary across
  resumptions; a release request alone does not override it.

## Finish without leaving hidden work

1. Validate the final combined change and review its diff. Report implemented requirements,
   evidence, open limitations and exclusions in the PR, following the [tracker rules](issue-tracker.md).
2. Complete the authorized PR, merge and deployment stages. Check their actual remote state before
   reporting success. When claiming a whole batch is complete, reconcile every PR in that scope,
   including drafts; explicitly list anything left open or excluded.
3. For an old draft, check both commit ancestry and equivalent behavior on current main. Compare
   its issue with current scope before reviving it. Close cancelled work as not planned, with a
   reason, rather than counting it as implemented.
4. Remove this task's temporary data, preview processes, downloaded artifacts and completed
   worktrees after verification and integration. Check for uncommitted or unmerged work first;
   preserve unfinished work and report it. Keep signing inputs until publication is verified.

Project guides describe current operation. ADRs preserve decisions and explicit amendments;
research notes preserve dated evidence. Correct stale guidance at its source, link instead of
duplicating it, and avoid turning a session report into another permanent rulebook.
