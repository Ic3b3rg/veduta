# Issue tracker: GitHub

Use `gh` for `Ic3b3rg/veduta`; confirm the repository from the Git remote. Issues hold the
canonical specifications and acceptance criteria, with later discussion in comments. PRs
carry implementations. Resolve ambiguous numbers because both share GitHub's number space.

## Lifecycle

- Read the issue body, comments and relevant linked decisions before implementation. Keep one
  canonical specification instead of creating a second copy in repository working notes.
- Publish implementation tickets with acceptance criteria, parent references and blockers.
  Use native dependencies where available, otherwise an explicit `Blocked by: #...` section.
- A blocker must be satisfied before dependent work starts. A closed-but-cancelled issue does
  not satisfy an implementation dependency automatically; reconcile the requirement first.
- Each triaged issue has one category (`bug` or `enhancement`) and one state label from the table
  below. Preserve area/dependency labels. Reconcile contradictory labels from observed state;
  ask only when the intended disposition is unclear.
- Keep PRs focused on their issue. State the resulting behavior, satisfied criteria, actual
  validation and remaining limitations. Use a body file with `gh --body-file` for multiline text.
- Mark issues completed only after their criteria and required integration are verified.
  Use `not planned` for cancellation and retain its reason. Publishing child tickets alone
  neither completes nor closes their parent.

## State labels

| Label             | Meaning                                         |
| ----------------- | ----------------------------------------------- |
| `needs-triage`    | Maintainer evaluation needed                    |
| `needs-info`      | Waiting for necessary information               |
| `ready-for-agent` | Specified, with blocking requirements satisfied |
| `ready-for-human` | Requires human implementation                   |
| `wontfix`         | Cancelled or otherwise not planned              |

## Optional Wayfinder maps

When using Wayfinder, the map issue has `wayfinder:map`; decision sub-issues use the appropriate
`wayfinder:<type>` label. Track dependencies as above. The frontier contains unassigned open
children whose blocking requirements are satisfied.
