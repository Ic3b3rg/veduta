# Issue tracker: GitHub

Work for this repository is tracked in GitHub Issues under `Ic3b3rg/veduta`. The issue body is the
canonical specification and acceptance criteria; comments carry discussion and later findings. Use
the `gh` CLI for tracker operations. Do not create a second issue specification in the repository.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue and its comments with `gh issue view <number> --comments`.
- List issues with `gh issue list`, including labels and comments when required.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit`.
- Close an issue with `gh issue close`.
- Do not close or rewrite a parent issue while publishing child implementation tickets.
- New implementation tickets should reference their parent issue.
- Apply `ready-for-agent` to agent-ready tickets.

Infer the repository from the current Git remote.

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub shares one number space across issues and pull requests. Resolve ambiguous references before
acting.

## Blocking relationships

Use GitHub native issue dependencies when available. Create tickets in dependency order so blocker
identifiers already exist.

If native dependencies are unavailable, add an explicit `Blocked by: #<number>` section to the
issue body.

A ticket is ready to start only when every blocking issue is closed.

## When a skill says "publish to the issue tracker"

Create a GitHub issue with its complete specification and acceptance criteria, establish its
blocking relationships, and apply the configured label.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` and read the complete issue body and discussion.

## Wayfinding operations

A Wayfinder map is one GitHub issue labelled `wayfinder:map`, with decision tickets represented as
sub-issues where supported.

Child tickets use the appropriate `wayfinder:<type>` label. Native dependencies represent blocking
relationships; otherwise use an explicit `Blocked by` section.

The frontier consists of unassigned open child tickets whose blockers are all closed.
