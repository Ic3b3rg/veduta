# First-party Skills guide typed tools without granting authority

> Superseded by [ADR-0026](0026-skills-may-drive-general-tool-execution.md), which preserves the
> first-party format and activation decisions but permits direct CLI/API use through general
> execution.

Reusable procedures improve an Agent's reliability when a feature has provider semantics,
multi-step judgment, or a consistent output discipline that does not belong in the global prompt.
Hermes demonstrates the value of a broad progressively loaded Skill catalog, but its repository
also combines a custom metadata dialect, advisory eligibility, terminal commands, scripts, and
plugin behavior under the same name. Copying that filesystem-as-runtime model would duplicate
Veduta's typed tool, trust, connection, and Automation contracts.

Veduta adopts the strict Agent Skills document core. An official Skill is first-party,
repository-reviewed, versioned product content with one SKILL.md containing standard frontmatter
and Markdown. Optional Veduta extensions use flat string keys under metadata.veduta.*; unknown or
non-standard top-level fields fail validation. In v1 a Skill may reference focused Markdown files
under references/ one hop at a time. Executables and non-document assets are deferred to v1.1,
where first-party additions are tested and released as product code rather than treated as trusted
because a Markdown file names them.

Progressive disclosure is metadata index → complete SKILL.md → one named reference. SKILL.md
targets 100–200 lines, produces a CI warning above 200 lines, and fails above 500 lines or 5,000
tokens. CI also checks schema, name/directory identity, local links, required typed ToolDefs,
forbidden executables, and feature behavior. The catalog grows only alongside real features that
need a reusable procedure; v1 has no quota, imported catalog, Hub, marketplace, third-party loader,
user-authored Skill, Agent-authored Skill, picker, or slash command.

Activation is hybrid. During an interactive turn the Agent receives deterministic metadata for
eligible Skills and autonomously chooses whether to load one. A confirmed Automation instead
causes the Gateway to preload its associated compatible Skill deterministically. Eligibility is a
code decision over exact ToolDef names and connected provider capabilities. A missed interactive
load is a routing-quality defect covered by tests and Trace; it is not a runtime permission gate.

A Skill teaches procedure only. It grants no ToolDef, credential, egress domain, trust relaxation,
Approval, Space access, provider capability, trigger, mutation, or output destination. Typed
Gateway tools, the user's current request or confirmed Automation, the trust layer, and the Event
log remain the enforcement boundary. Provider CLIs such as Himalaya live behind adapters and are
never taught as Agent-facing commands.

Each use records Skill id, version, content hash, and compatibility decision in Trace or technical
Automation details, not ordinary chat or Surfaces. A run resolves the newest compatible version.
An older version remains only while an incompatible existing Automation still references it and is
garbage-collected after the last reference disappears. A Skill owns no connection, Space, Surface,
memory, notification, or Automation state.

The rejected alternatives are treating Skill metadata as authority, silently accepting unknown
extensions, exposing raw shell or provider commands, allowing arbitrary downloaded code, injecting
every Skill into every turn, making users select implementation details, or retaining every old
version indefinitely. The detailed Hermes comparison and decision matrix are recorded in
[research 16](../references/16-hermes-skills-architecture.md). The first real consumer is the
mailbox-assistant Skill in issue #122; deterministic Automation loading and lifecycle complete in
issue #126.

Status: superseded by [ADR-0026](0026-skills-may-drive-general-tool-execution.md)
