# Issue tracker: GitHub

Work for this repository is tracked in GitHub Issues under `Ic3b3rg/veduta`. Use the `gh` CLI for
tracker operations.

The repository also maintains canonical specifications under `issues/`, mirrored 1:1 with GitHub
issue numbers. After GitHub assigns an issue number, create or update the matching
`issues/<NNN>-<slug>.md` file and keep both representations aligned.

## Conventions

- Create an issue with `gh issue create`.
- Read an issue and its comments with `gh issue view <number> --comments`.
- List issues with `gh issue list`, including labels and comments when required.
- Comment with `gh issue comment <number>`.
- Apply or remove labels with `gh issue edit`.
- Close an issue with `gh issue close`.
- Do not close or rewrite a parent issue while publishing child implementation tickets.
- New implementation tickets should reference their parent issue and matching repository
  specification.
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

Create a GitHub issue, establish its blocking relationships, apply the configured label, and
create its matching specification under `issues/`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments` and read the matching specification under `issues/` when
present.

## Wayfinding operations

A Wayfinder map is one GitHub issue labelled `wayfinder:map`, with decision tickets represented as
sub-issues where supported.

Child tickets use the appropriate `wayfinder:<type>` label. Native dependencies represent blocking
relationships; otherwise use an explicit `Blocked by` section.

The frontier consists of unassigned open child tickets whose blockers are all closed.
