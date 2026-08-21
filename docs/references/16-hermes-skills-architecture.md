# Research 16 — Hermes Agent skills architecture

> Conducted on 2026-08-19 against
> [NousResearch/hermes-agent at `13ce0c5`](https://github.com/NousResearch/hermes-agent/commit/13ce0c5c675e843af70d19c9e5144249cd51c8d1)
> and the
> [Agent Skills specification at `69ef37e`](https://github.com/agentskills/agentskills/commit/69ef37e9424c0a7ea9dd2293b559e43ec8176379).
> Inventory figures below are reproducible counts of those pinned trees. Statements labelled
> **absence** or **inference** describe this revision, not a product guarantee.

## Finding

Hermes treats a skill as an on-demand procedure package: a compact name/description index enters
the system prompt, the model or user selects a skill, and `skill_view` loads its full instructions
and then individual support files. A skill guides calls to tools already present in the session; it
does not define a typed capability boundary or grant authority. Hermes also lets skills carry
scripts, credentials/config prerequisites, cron blueprints, and lifecycle metadata, so its runtime
is much broader than the portable `SKILL.md` core.
([prompt index](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/prompt_builder.py#L1763-L1787),
[mandatory model routing](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/prompt_builder.py#L2104-L2131),
[`skills_list`/`skill_view` contracts](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L1970-L2012))

Veduta should adopt the portable document format, progressive disclosure, and Hermes's useful
separation between Skills and tools already available to the Agent. In v1, a Skill is still
product-owned and versioned, but it may teach typed tools, direct CLI/API use, and dependency setup
through Veduta's general execution tool. It grants no new tool or credential; the breadth comes
from the Agent runtime, while Veduta's differentiator is that outcomes become persistent validated
Surfaces inside Spaces. This revised conclusion is recorded in
[ADR-0026](../adr/0026-skills-may-drive-general-tool-execution.md).

## 1. Catalog inventory

The pinned repository contains two core catalogs and one plugin-provided skill:

| Tree                                                                                                                                                      | Skill packages | Files | Skill-bearing categories |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------: | ----: | -----------------------: |
| [`skills/`](https://github.com/NousResearch/hermes-agent/tree/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills)                                            |             82 |   485 |                       14 |
| [`optional-skills/`](https://github.com/NousResearch/hermes-agent/tree/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills)                          |            117 |   555 |                       21 |
| [`plugins/google_meet/SKILL.md`](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/plugins/google_meet/SKILL.md) |              1 |     — |                   plugin |

Thus the two catalogs contain 199 skills; the whole repository contains 200 `SKILL.md` files.
`skills/index-cache/` is a non-skill cache directory, so it is excluded from the 14 bundled
categories.

The categories span provider workflows, productivity, software development, research, creative,
MLOps, DevOps, finance, security, and other domains; category totals above are filesystem counts,
not a runtime registry.

Support-package use is substantial:

| Tree                       | `scripts/` | `references/` | `templates/` | `assets/` | `examples/` |
| -------------------------- | ---------: | ------------: | -----------: | --------: | ----------: |
| Bundled: packages / files  |    17 / 65 |      27 / 177 |     10 / 112 |     0 / 0 |       0 / 0 |
| Optional: packages / files |    36 / 91 |      61 / 276 |      11 / 27 |     2 / 4 |      1 / 15 |

The runtime treats these as support areas rather than nested discovery roots.
([scanner exclusions](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L47-L51),
[documented package layout](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/skills.md#L302-L325))

## 2. Format and Agent Skills compatibility

The Agent Skills base requires a directory with `SKILL.md`, YAML frontmatter, and Markdown. Only
`name` and `description` are required; `license`, `compatibility`, `metadata`, and experimental
`allowed-tools` are optional. `metadata` is a map from string keys to string values. `scripts/`,
`references/`, and `assets/` are conventions, and extra files are allowed.
([format](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L6-L32),
[support directories](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L187-L215))

The official validator permits exactly those six fields and rejects other top-level fields.
([validator allowlist](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py#L10-L22),
[extra-field rejection](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py#L104-L115))

Hermes claims compatibility with agentskills.io, but its shipped schema is an extension, not strict
conformance. All 199 catalog skills have `version`, `author`, and `platforms`, because Hermes CI
requires them; therefore **0/199 pass the official validator's top-level-field allowlist**.
Hermes also commonly stores arrays and nested objects under `metadata.hermes`, whereas the standard
defines string values. All 199 names nevertheless satisfy the stricter standard kebab-case shape.
([compatibility claim](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/skills.md#L7-L13),
[Hermes required fields](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tests/skills/test_authoring_standards.py#L82-L95),
[Hermes metadata example](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/CONTRIBUTING.md#L423-L449))

Hermes also uses non-base fields including `dependencies` (42), `prerequisites` (28), `tags` (7),
and `triggers` (4), plus tool/toolset conditions, setup variables, config, and blueprints.
([conditional fields](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/CONTRIBUTING.md#L489-L529),
[setup fields](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/CONTRIBUTING.md#L531-L563),
[blueprint parser](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/blueprints.py#L95-L140))

For Veduta, strict portability means string-valued flat keys such as
`metadata['veduta.version']` and `metadata['veduta.required-tools']`; nested
`metadata: { veduta: {...} }` would be a deliberate non-standard extension.
([metadata rule](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L147-L161))

Veduta must not interpret standard `allowed-tools` as an authority grant or pre-approval: the field
is explicitly experimental and client-dependent. At most, v1 should reject it or retain it as
uninterpreted portability metadata. Actual tool availability—including the general execution
tool—comes from the current AgentRunner turn, not from the Skill file.
([`allowed-tools`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L163-L174))

## 3. Discovery, eligibility, and activation

Hermes scans trusted project directories first, then the active profile's `~/.hermes/skills`, then
configured external directories. Project locations are `<repo>/.hermes/skills` and
`<repo>/.agents/skills`; they load only after the repository root is trusted. Support areas,
virtual environments, VCS data, caches, and archives are pruned. Plugin skills use qualified names
such as `plugin:skill`.
([precedence](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L622-L655),
[trust resolution](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L699-L767),
[plugin dispatch](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L1072-L1208))

Offer-time eligibility filters disabled skills, operating system, known environments, and four
`metadata.hermes` conditions: `requires_tools`, `requires_toolsets`, `fallback_for_tools`, and
`fallback_for_toolsets`. Environment gating is intentionally bypassed by explicit loads; unknown
environment tags fail open. Tool conditions control visibility, not permission.
([environment semantics](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L275-L285),
[condition extraction](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L993-L1010),
[condition evaluation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/prompt_builder.py#L1716-L1744))

Activation is either model-selected (`skill_view` after scanning descriptions), explicit
(`/skill-name`, up to five stacked skills or a bundle), CLI-preloaded, or attached to a cron job.
Natural activation is LLM routing, not a trigger engine: the system prompt says to load any even
partially relevant skill.

Veduta's agreed activation model is hybrid. In an interactive turn, the Agent receives the index
of applicable Skills and chooses one or more relevant instructions to load. A confirmed Automation
instead names its associated Skill set, which the Gateway preloads deterministically for each run.
In both paths, loading a Skill neither widens the stored request or Automation instruction nor
grants a capability. A missing external command may keep a setup-capable Skill visible so the Agent
can install or configure it on an explicit request.

Interactive loading is mandatory Agent procedure, but it is not a Gateway authorization gate. If
the Agent omits a relevant Skill, any tool already offered to the turn remains callable; the
omission is a routing-quality defect to expose in tests and the Trace. Typed tools may enforce
domain invariants, while direct commands rely on reviewed Skill behavior and audit rather than on
whether a Markdown file happened to be loaded. Deterministic Automation preload avoids routing
uncertainty for recurring work.

Skill selection stays out of ordinary chat copy and Surface content. The user sees the requested
result, while technical views expose the loaded Skill identity, version, content hash, and named
references. Automation details may show the same dependency information for diagnosis; routine
outcomes should not force Skill terminology into the user's mental model.

Accordingly, v1 exposes no slash command, Skill picker, or management UI. The user states the
desired outcome in natural language; the Agent must select and load all relevant Skills
autonomously, while a confirmed Automation gets its associated Skill set preloaded by the Gateway.
Technical views are observational rather than a second activation path.

**Observed absence:** the four shipped top-level `triggers` declarations
are not consumed by the core parser or router at this revision. The only deterministic activation
filters are platform, environment, disabled status, and tool/toolset availability.
([routing instruction](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/prompt_builder.py#L2104-L2131),
[parsed activation conditions](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L993-L1010))

Slash discovery registers a command per eligible skill, resolves collisions by precedence, and
wraps the full body as a user message. Hermes injects the package path and permits its scripts via
the terminal; `/reload-skills` rescans commands but not the system-prompt cache.
([slash scan](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L419-L525),
[message assembly](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L306-L396),
[reload behavior](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L546-L573))

Progressive disclosure has three effective levels: metadata index, full `SKILL.md`, then one named
support file. `skill_view` prevents absolute/traversal lookups, verifies file containment, returns
linked files and readiness, and deduplicates repeated unchanged reads within a task until context
compression resets the tracker. Veduta should apply this shape in v1, including focused Markdown
files under `references/`; postponing the split itself would defeat progressive disclosure. Each
`SKILL.md` should target 100–200 lines, produce a CI warning above 200 lines, and fail validation
above either 500 lines or 5,000 tokens. References should remain focused and directly linked rather
than becoming a second monolithic instruction file or a deep reference tree.
([documented levels](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/website/docs/user-guide/features/skills.md#L149-L159),
[path containment](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L1503-L1530),
[repeat-view dedup](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L2013-L2029))

## 4. Dependencies, scripts, and configuration

Hermes normalizes required environment variables from three forms, may prompt securely in an
interactive client, and returns a setup hint instead of collecting secrets in messaging sessions.
Available declared variables are registered for sandbox passthrough; declared credential files can
be mounted into remote execution backends. Config values declared under `metadata.hermes.config`
are resolved into the skill message.
([environment normalization](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L283-L406),
[capture boundary](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L409-L484),
[sandbox/credential registration](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L1722-L1761),
[config injection](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L267-L303))

Command prerequisites are advisory: parsed commands never populate the returned readiness arrays,
and generic `dependencies` are outside core readiness.
([prerequisite parsing](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L275-L292),
[readiness payload](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L1845-L1868))

Hermes can execute support scripts because loaded instructions expose their absolute path to the
general terminal tool. It also supports `${HERMES_SKILL_DIR}` and `${HERMES_SESSION_ID}` template
substitution by default and optional inline `!` shell expansion through `bash -c`; inline shell is
off by default. These are execution features, not properties required by Agent Skills.
([script execution instruction](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L331-L340),
[preprocessor](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_preprocessing.py#L12-L23),
[shell execution and defaults](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_preprocessing.py#L65-L143))

Veduta v1 adopts direct external-tool use without putting executables inside Skill packages. A
first-party Markdown Skill may tell the general execution tool to detect, install, configure, and
run a CLI or call an API. First-party `scripts/` and other executable support assets remain a v1.1
addition because they become shipped product code. Dependency readiness is observable, but a
missing command is not automatically fatal when the same Skill contains its supported setup path.

## 5. Automations, memory, and subagents

A cron job stores an ordered `skills` list. At every run Hermes loads each full skill, skips a
missing one with a warning, appends the stored job prompt, bumps usage, and scans the assembled
prompt for injection. Missing declared environment variables or credential files block preflight;
missing command checks cannot, because readiness never populates them.
([cron skill loading](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/scheduler.py#L3922-L4019),
[assembled-prompt scan](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/scheduler.py#L4030-L4097),
[readiness preflight](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/scheduler.py#L4372-L4425))

A skill may carry `metadata.hermes.blueprint`; installation registers a pending cron suggestion,
never a job automatically. Only user acceptance materializes the Automation. This separation is a
useful precedent, although Veduta should keep the confirmed Automation—not the Skill—as the owner
of trigger, scope, operation, and output.
([blueprint semantics](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/blueprints.py#L172-L223),
[suggestion acceptance](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/cron/suggestions.py#L215-L247))

Veduta Automations should reference a stable ordered Skill set and resolve each newest compatible
version at every run. Compatible updates migrate automatically; the Trace records every resolved
identity, version, and content hash. When an update is incompatible with an existing confirmed
Automation, its last compatible version remains installed only while at least one such Automation
references it. New Automations use current versions. Migrating or removing the final reference
garbage-collects the retained version, so obsolete unreferenced packages do not accumulate.

Hermes separates compact facts in memory from longer procedures in Skills and strips slash-injected
skill bodies before memory processing. Skills may instruct `delegate_task`, but cannot grant it.
([memory/skill distinction](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/prompt_builder.py#L171-L191),
[slash scaffold stripping](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L31-L47),
[delegation procedure](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/optional-skills/software-development/subagent-driven-development/SKILL.md#L56-L117))

## 6. Security and lifecycle

A skill is instruction, not a capability container. **Implementation inference:** Hermes does not
bind a loaded skill to a least-privilege tool set; it filters the index using the session's existing
tool registry, then the body may instruct use of any already-available tool. `allowed-tools` is not
consumed by the Hermes runtime. Consequently, a malicious loaded skill can steer the terminal or
other powerful tools the session already has.
([tool-registry-derived eligibility](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/system_prompt.py#L488-L517),
[tool conditions](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/prompt_builder.py#L1716-L1744),
[terminal instruction](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_commands.py#L331-L340))

Hub installs first enter quarantine and undergo structural, regex, invisible-character, and
content-hash scanning. Limits are 50 files, 1 MiB total, and 256 KiB per file; installed bundles
reject symlinks. The trust policy allows every verdict for built-ins, blocks dangerous trusted
sources, and blocks caution/dangerous community sources; `--force` may override caution but never
dangerous for trusted/community sources. This is a heuristic scanner, not a sandbox.
([scanner and limits](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_guard.py#L526-L568),
[trust policy](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_guard.py#L44-L67),
[`--force` boundary](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_guard.py#L787-L828),
[symlink rejection and provenance](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_hub.py#L4028-L4065))

Trusted project skills are rescanned by content hash and dangerous results fail closed. Ordinary
local, external, and plugin skills differ: basic prompt-injection pattern matches are logged but
their content is still served. Agent-created skill scanning is disabled by default because Hermes
notes that the same code could already run through the terminal.
([project quarantine](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/skill_utils.py#L807-L876),
[local warning-only behavior](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_tool.py#L1443-L1471),
[agent-created guard default](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skill_manager_tool.py#L97-L149))

Bundled skills are copied into each profile and tracked by `.bundled_manifest`. Updates replace
only pristine copies, preserve local edits, respect user deletions, and can be disabled with
`.no-bundled-skills`. Optional skills install through the hub. Hub lock records source, identifier,
hash, install path, files, and scan provenance; updates re-fetch the same source and do not silently
overwrite local edits.
([bundled sync contract](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_sync.py#L1-L22),
[opt-out marker](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_sync.py#L98-L105),
[hub provenance](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_hub.py#L4043-L4065),
[update comparison](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skills_hub.py#L4148-L4216))

The Agent can mutate packages; hard validation covers basic structure and paths, while richer
linting is advisory. Write approval and agent-created scanning default off. A Curator may archive
only curator-managed content, protecting foreground-created, hub, pinned, and external skills.
([manager actions](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skill_manager_tool.py#L1-L32),
[hard validation](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/skill_manager_tool.py#L527-L635),
[approval default](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tools/write_approval.py#L18-L40),
[Curator invariants](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/agent/curator.py#L1-L20))

Veduta's official release boundary is narrower: v1 Skills are first-party files reviewed and tested
in the public repository. First-party executables considered for v1.1 are product code and receive
the same security review before release. This boundary does not restrict downstream freedom: the
project is open source, and anyone may fork it, add or replace Skills and executables, and distribute
their own build. Veduta simply makes no claim about code outside its official releases. A built-in
community loader, Hub, or third-party execution contract remains a separate future product scope.
The general execution tool means even a Markdown Skill can cause powerful effects through installed
software, so review and behavioral tests—not the file extension—define the upstream release
boundary.

## 7. Representative patterns and test coverage

- `email-inbox-triage` is a good router/procedure pattern: it owns explicit scope,
  thread-aware classification, approval, and verification, while `himalaya` and
  `google-workspace` own provider commands. Veduta should preserve that separation and allow the
  connector Skill to use the relevant native tool or CLI directly.
  ([triage boundary](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L14-L37),
  [approval/verification](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/email/email-inbox-triage/SKILL.md#L53-L87))
- `test-driven-development` is a pure behavioral instruction: valuable as policy, with no package
  executable required.
  ([skill](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/software-development/test-driven-development/SKILL.md#L14-L53))
- `competitor-news-monitor` composes a procedure, durable cursor file, and cron job. It illustrates
  useful recurrence but also why Veduta must keep state and Automation ownership outside the Skill.
  ([setup and schedule](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/research/competitor-news-monitor/SKILL.md#L14-L54),
  [scheduled tick](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/skills/research/competitor-news-monitor/SKILL.md#L56-L88))
- Unreviewed downloaded Skills, self-modifying guidance, silent dependency failures, and pretending
  that a broad terminal is a least-privilege boundary remain anti-patterns for Veduta's official
  release.

Tests are strong around infrastructure but sparse per package. `tests/skills/` has 38 modules and
88 test modules anywhere under `tests/` contain `skill` in the filename, covering discovery,
commands, prompts, Hub, guards, project/external/plugin loading, cron, and lifecycle. Only 11
executable tests live inside six skill packages (ComfyUI, four office-document skills, and
`ast-grep`). The all-catalog authoring test validates required Hermes fields, tags, directory/name
matching, description style, related-skill resolution, local paths, and a 100K-character ceiling;
it does not enforce the official Agent Skills field allowlist or the full recommended body-section
order.
([runtime test tree](https://github.com/NousResearch/hermes-agent/tree/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tests),
[skill-specific test tree](https://github.com/NousResearch/hermes-agent/tree/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tests/skills),
[catalog enforcement](https://github.com/NousResearch/hermes-agent/blob/13ce0c5c675e843af70d19c9e5144249cd51c8d1/tests/skills/test_authoring_standards.py#L75-L149))

## 8. Decision matrix for Veduta

| Decision          | Scope                                                                                                          | Rationale                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Adopt**         | Strict Agent Skills base: `SKILL.md`, `name`, `description`, optional base fields                              | Portable authoring contract; validate with the official field allowlist.                                                                          |
| **Adopt**         | Flat string extension keys under `metadata.veduta.*`                                                           | Keeps extensions spec-valid and avoids Hermes's nested non-conformance.                                                                           |
| **Adopt in v1**   | Metadata index → full instructions → individual Markdown files under `references/`                             | Bounded context and auditable progressive disclosure are part of the base authoring model, not a later executable feature.                        |
| **Adopt in v1**   | `SKILL.md` target 100–200 lines; warn above 200; fail above 500 lines or 5,000 tokens                          | Keeps primary procedures concise while allowing focused detail to move into on-demand references.                                                 |
| **Adopt**         | First-party, repository-reviewed, versioned Skills only in v1                                                  | Matches Veduta's product-owned procedure definition and release process.                                                                          |
| **Adopt**         | Grow the first-party catalog feature by feature, only where a reusable Agent procedure is actually needed      | Avoids both a fixed launch quota and speculative ports of Hermes Skills that duplicate product policy or unused workflows.                        |
| **Adopt**         | Applicability from platform, offered tools, connected capabilities, and setup state                            | The Agent sees runnable Skills and setup-capable Skills that can repair a missing external dependency.                                            |
| **Adopt**         | Hybrid activation: Agent-selected Skill sets in interactive turns; deterministic preload for Automations       | Preserves flexible conversational composition while making confirmed recurring work reproducible.                                                 |
| **Adopt**         | Test and trace missed interactive Skill routing without treating load state as authorization                   | Skills improve procedure quality; any tool already offered to the turn remains callable.                                                          |
| **Adopt**         | Keep Skill identity and loading details in the Trace and technical Automation details                          | Normal chat and Surfaces present the user's result without implementation noise.                                                                  |
| **Adopt**         | Skills guide typed tools, direct CLI/API use, and dependency setup but never grant tools                       | Capability comes from the turn's tool registry; official Skill behavior, Approval UI, Trace, and audit govern broad execution.                    |
| **Adopt**         | Every invocation belongs to exactly one Space and emits text plus validated Surface updates                    | A Skill owns no Surface, connection, memory, notification, or cross-Space state.                                                                  |
| **Adopt**         | Automation remains `trigger → confirmed operation/scope → result`                                              | It may reference a Skill/version as implementation guidance, but the Skill cannot add a query, backlog, mutation, trigger, or output destination. |
| **Adopt**         | Resolve the newest compatible Skill per Automation run and retain older versions only while referenced         | Preserves confirmed recurring work without accumulating obsolete, unreferenced packages; Trace records the exact version and hash used.           |
| **Adopt in v1**   | External CLI/API use and supported dependency setup through general execution                                  | Keeps the Agent flexible without requiring a domain adapter for every mature tool.                                                                |
| **Adopt**         | CI for schema, identity, links, size, declared requirements, forbidden package executables, and behavior tests | Avoids Hermes's gap between broad prose standards and partial enforcement.                                                                        |
| **Defer**         | User/community installation, Hub, external/project/org directories, taps, and update provenance                | Valuable ecosystem features, but unnecessary supply-chain and collision surface for v1.                                                           |
| **Defer**         | User-authored, Agent-authored, and self-modifying Skills; background Curator                                   | Requires a product model for review, versioning, rollback, ownership, and migration.                                                              |
| **Defer**         | Slash aliases, pickers, user-selected bundles, session preloads, and Skill-authored Automation suggestions     | The v1 user asks for outcomes in natural language; the Agent may still load multiple relevant Skills autonomously.                                |
| **Defer**         | Skill-declared secrets/config                                                                                  | Provider connections and secrets should remain Gateway-owned; later metadata may describe eligibility without exposing values.                    |
| **Defer to v1.1** | First-party executable `scripts/` and non-document support assets                                              | Shipped executables are product code and require the same repository review, testing, and release security as the rest of Veduta.                 |
| **Reject in v1**  | Executable support files shipped inside Skill packages                                                         | First-party package executables enter in v1.1 as reviewed and tested product code; external installed tools remain usable in v1.                  |
| **Reject**        | `allowed-tools` or metadata as pre-approval/authority                                                          | File content is not a trust decision.                                                                                                             |
| **Reject**        | Unknown extension fields silently ignored or dependency failure presented as successful readiness              | Schema handling must be deterministic and setup/unavailable states must remain truthful.                                                          |

### Mailbox v1 application

`mailbox-assistant` should own explicit scope, thread handling, summary shape, Approval behavior,
and the persistent result contract. It may ask the Agent to load a connector Skill: Gmail can use
native OAuth/API operations, while `himalaya` can teach compatible installation, account setup,
structured output, and direct CLI commands through the general execution tool. Provider parity is
required at the text and Mailbox Surface boundary, not at the command schema.

The Skill may not poll by default, silently widen an Automation's time window, mark search results
read, or persist raw provider content. Official behavior asks for Approval before a consequential
command and verifies the result, while ADR-0026 records that general execution is not an
unbypassable domain capability gate. Product-polished v1 flows cover search/summary, explicit open,
and threaded reply; an explicit chat request may still use other capabilities exposed by an
installed CLI without first waiting for a dedicated provider adapter.

The practical conclusion is to copy Hermes's **procedure packaging, progressive loading, and
direct use of mature external tools**, while keeping Veduta's own differentiator: one personal
Agent whose text and validated generative Surfaces persist inside explicit Spaces and whose
confirmed Automations keep durable trigger, operation, and output state.
