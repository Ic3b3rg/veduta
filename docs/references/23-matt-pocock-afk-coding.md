# Matt Pocock's AFK coding workflow

_Researched 2026-09-01. This note distinguishes Matt Pocock's public workflow guidance,
the open Sandcastle implementation, and inferences about his current private setup._

## Conclusion

Matt's AFK workflow is not a single skill and it is not an unattended version of the public
skills flow. It has three separate layers:

1. **Human-led shaping:** clarify the idea, record durable vocabulary and decisions, write a spec,
   and split it into small vertical-slice tickets with explicit blockers.
2. **A Ralph-style execution loop:** start a fresh agent context for one eligible task, run feedback
   loops, commit, record progress, and repeat until a bounded stop condition is reached.
3. **Sandcastle orchestration:** run those agents in isolated sandboxes and separate branches or
   worktrees, optionally using planner, implementer, reviewer, and merger roles in parallel.

The public skills stop before orchestration. Matt's current `/implement` documentation explicitly
says that the user must invoke it per ticket and that no skill can invoke it implicitly. It is an
instruction to the operator, not an AFK scheduler. See [The `/implement` Skill](https://www.aihero.dev/skills-implement)
and the public [skills repository](https://github.com/mattpocock/skills).

## The human "day shift"

The current public skill chain is:

```text
grill-with-docs -> to-spec -> to-tickets -> implement -> code-review
```

`grill-with-docs` resolves ambiguity with the human and records canonical vocabulary in
`CONTEXT.md` and durable decisions in ADRs. `to-spec` captures the agreed destination.
`to-tickets` turns it into context-window-sized tracer-bullet tickets and records their blocking
edges. Each ticket must deliver a narrow end-to-end behavior rather than one horizontal layer.
The operator approves this breakdown before it is published. See Matt's
[grill-with-docs documentation](https://www.aihero.dev/grill-with-docs),
[`to-tickets` documentation](https://www.aihero.dev/skills-to-tickets), and
[full workflow talk](https://ai.engineer/talks/-QFHIoCo-Ko-ai-coding-workflow).

This preparation is the main control mechanism. Matt keeps product judgment, architecture,
high-risk integrations, and final quality human-led. In the talk, he recommends turning work AFK
only after humans have shaped and reviewed the issue graph. Independent branches of that graph can
then run concurrently.

## The basic Ralph loop

Matt's minimal public setup uses two scripts:

- `ralph-once.sh` runs one watched iteration so the operator can observe failures and tune the
  prompt.
- `afk-ralph.sh` starts a new non-interactive agent process on each iteration and caps the maximum
  number of iterations.

Each iteration receives a plan or PRD plus durable progress, selects one incomplete task, explores
the repository, implements the task, runs tests and type checks, commits, updates progress, and
emits a completion sentinel when the destination is complete. The important property is a **fresh
context per iteration**; the repository, plan, progress record, and git history carry state instead
of a growing conversation. Matt therefore argues against a same-session Ralph plugin, because it
accumulates prior iterations in one context window. See [Getting Started With Ralph](https://www.aihero.dev/getting-started-with-ralph),
[11 Tips For AI Coding With Ralph Wiggum](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum),
and [Why the Anthropic Ralph plugin sucks](https://www.aihero.dev/why-the-anthropic-ralph-plugin-sucks).

Matt recommends rehearsing HITL before going AFK, limiting a run rather than using an infinite
loop, and returning to review its commits. His published rule of thumb is 5-10 iterations for small
work and 30-50 for larger work. He reports typical loops of 30-45 minutes, sometimes hours, with a
small WhatsApp notifier when a run finishes. The same article says that, at that point in his
workflow's evolution, most of his own usage was still HITL rather than AFK.

## Safety and feedback

For AFK work, Matt treats sandboxing as essential. The agent needs non-interactive permission to
edit, execute commands, and commit, so he runs it inside a Docker sandbox rather than disabling
permissions on the host. His basic guide notes an important consequence: user-global instructions
and skills are not present in the container. Required instructions must therefore be part of the
repository or the prompt supplied to the sandbox. See [11 Tips, Docker Sandboxes](https://www.aihero.dev/tips-for-ai-coding-with-ralph-wiggum#9-use-docker-sandboxes).

The prompt requires small steps and deterministic feedback: red-green-refactor where applicable,
then the repository's type checking, tests, linting, or browser feedback before committing. Risky
architecture and integration work stays HITL until the foundation is proven. AFK is reserved for
bounded execution where the completion evidence is already clear.

Automated checks are not treated as final proof. In Matt's workflow talk, tests and type checks pass
but manual use still exposes a missing database table. His recommendation is a fresh-context model
review followed by human QA and code review. See the talk's section
[Automate implementation, not ownership of quality](https://ai.engineer/talks/-QFHIoCo-Ko-ai-coding-workflow).

## Sandcastle: the public AFK execution layer

Sandcastle is Matt's open TypeScript library for programmatically running a chosen coding agent
inside a chosen sandbox with a prompt. It supports Docker, Podman, Vercel, and custom providers;
current agent adapters include Claude Code, Codex, Pi, Cursor, OpenCode, and Copilot. It manages
worktrees or branches, logs, iteration limits, completion signals, timeouts, session capture, and
commit collection. See the [Sandcastle repository and README](https://github.com/mattpocock/sandcastle)
and Matt's [launch video](https://www.youtube.com/watch?v=E5-QK3CDVQM).

`sandcastle init` can scaffold these public workflow templates:

- simple issue loop;
- sequential implementation plus review;
- parallel planner;
- parallel planner with per-branch review.

The checked-in dogfood example makes the orchestration concrete. It caps the outer loop at ten
iterations and four parallel tasks. A planner selects compatible issues; each receives a separate
Docker sandbox and branch; an implementer follows the issue and feedback prompt; a separate agent
reviews the resulting branch; and a merger agent integrates completed branches and reruns checks.
See the public [orchestrator](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/run.ts),
[implementation prompt](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/implement-prompt.md),
and [merge prompt](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/merge-prompt.md).

## What Matt appears to run currently

The repository also contains a newer `.factory` integration. Its launcher builds a separate local
repository at `~/repos/ai/software-factory` and starts `factory daemon`. The daemon supplies one task
at a time through environment variables. Sandcastle then creates a task branch and worktree, starts
a Docker sandbox, runs an Opus implementer, and runs a separate Opus reviewer if commits were
produced. The file contract says the daemon pushes the branch and opens a pull request. See
[`run-daemon.sh`](https://github.com/mattpocock/sandcastle/blob/main/.factory/run-daemon.sh) and
[`implement-task.ts`](https://github.com/mattpocock/sandcastle/blob/main/.factory/implement-task.ts).

The `software-factory` repository referenced by that launcher was not present among Matt's public
GitHub repositories during this research. The defensible inference is that the durable daemon he
currently dogfoods is private or otherwise unpublished. Sandcastle and the checked-in prompts expose
the execution unit, but not the entire current scheduling and recovery control plane.

## Practical reconstruction

To reproduce the method rather than its marketing shorthand:

1. Put repository rules and every required skill inside the repository-visible sandbox context.
2. Produce a reviewed spec and tickets whose acceptance criteria can be verified without asking a
   human mid-run.
3. Keep high-risk architectural or visual decisions HITL.
4. Run one ticket repeatedly with a watched, single-iteration harness until its prompt and checks are
   reliable.
5. Move to a sandboxed, branch-only AFK run with a small iteration cap.
6. Add parallelism only for tickets whose blockers and write surfaces genuinely permit it.
7. Use a fresh reviewer and deterministic repository checks before opening a PR.
8. Keep merge, runtime QA, and product acceptance human-controlled until the project has evidence
   that narrower automation is reliable.

The key distinction is: **the skills make work agent-ready; Ralph supplies fresh repeated sessions;
Sandcastle supplies isolation and orchestration.** Installing the skills alone does not create an
AFK factory.
