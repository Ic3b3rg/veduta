# Research 19 — Hermes chat-directed extensibility

> Conducted on 2026-08-28 against
> [NousResearch/hermes-agent at `7b5e191`](https://github.com/NousResearch/hermes-agent/commit/7b5e1911f88be05eb5f9ce34453149dddd95ced3).
> This complements [Research 16](./16-hermes-skills-architecture.md), which is pinned to
> `13ce0c5` and remains the detailed source for Skill format, discovery, progressive disclosure,
> Hub scanning, and the basic Skill lifecycle. Statements labelled **absence** or **inference**
> describe the inspected revision, not a product guarantee.

## Finding

Hermes supports much of the requested experience, but not through one universal “install anything”
operation. Natural-language chat composes several purpose-built mechanisms:

- `skill_manage` and `/learn` create or modify procedure packages;
- `write_file` can create ordinary files and cron scripts;
- `cronjob` stores and manages scheduled work;
- Desktop's `setup_mcp` proposes a reviewed MCP through an explicit consent card;
- generic MCPs, credentials, model pins, and cross-agent imports still use dedicated CLI or settings
  flows.

The storage areas are profile-scoped, but the local execution boundary is the host OS user, not the
profile. More importantly, a Hermes cron job normally stores mutable names and paths rather than a
resolved, immutable capability graph: Skills, scripts, MCP configuration, and tool availability are
looked up again when the job fires. Hermes therefore demonstrates a strong conversational authoring
surface, but not the reproducibility or least-privilege boundary Veduta needs for confirmed
Automations.

## 1. Where extensions and credentials live

Hermes resolves an active profile through `HERMES_HOME`; named profiles repeat the same layout under
`~/.hermes/profiles/<name>/`. Its own operating Skill documents the source checkout separately at
`~/.hermes/hermes-agent/` for a git install.
([profile paths](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/skills/autonomous-ai-agents/hermes-agent/SKILL.md#L68-L85))

| Concern                           | Current location                                          | Ownership/lifecycle                                                                                            |
| --------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Settings, including `mcp_servers` | `$HERMES_HOME/config.yaml`                                | Profile-owned configuration; Hermes tells the Agent to use supported config commands rather than hand-edit it. |
| API keys and static secrets       | `$HERMES_HOME/.env`                                       | Profile-owned secret store; messaging sessions do not collect Skill secrets in chat.                           |
| Provider OAuth                    | `$HERMES_HOME/auth.json`                                  | Separate from settings and ordinary Agent-writable files.                                                      |
| Skills                            | `$HERMES_HOME/skills/`                                    | Bundled, Hub-installed, imported, and Agent-created packages share the local tree.                             |
| Skill support files               | `<skill>/{references,templates,scripts,examples,assets}/` | Written through `skill_manage`; executable files are still invoked through general tools.                      |
| Standalone cron scripts           | `$HERMES_HOME/scripts/`                                   | Referenced by a cron job by path and read at each run.                                                         |
| Cron jobs and output              | `$HERMES_HOME/cron/`                                      | Scheduler-owned state, including `jobs.json`; the supported mutation path is `cronjob`/`hermes cron`.          |
| Git-installed MCP payloads        | `$HERMES_HOME/mcp-installs/<server>/`                     | Re-cloned on explicit catalog reinstall.                                                                       |
| MCP OAuth state                   | `$HERMES_HOME/mcp-tokens/<server>.*`                      | Per-profile token, client, and metadata files.                                                                 |

The general user-state map confirms settings, `.env`, `auth.json`, Skills, session state, and cron
data are separate stores.
([user configuration map](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/CONTRIBUTING.md#L284-L296))
The Skill tree itself contains Hub state and install provenance under `.hub/`, while imported
support files are limited to named package areas and recorded with content hashes.
([Skill package and Hub layout](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L302-L332))

External and project-local Skills are additional discovery roots, not security boundaries. A
foreground Agent can update an external Skill in place when filesystem permissions allow it;
project-local Skills require an explicit repository trust decision before loading. New
Agent-created Skills still land in the profile-local tree.
([external mutability](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L373-L395),
[project trust and precedence](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L415-L456))

## 2. What chat can create or modify

### Skills and their files

`/learn` turns a directory, URL, prior conversation, pasted procedure, or large document set into a
Skill using the Agent's already-available tools. It is a normal Agent turn, not a separate ingestion
engine, and finishes through `skill_manage`, so the same write gate applies.
([`/learn` sources and execution](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L94-L147))

The model-facing `skill_manage` tool can create, patch, replace, delete, add a support file, or
remove one. Successful mutations clear the Skill prompt cache and append an audit-ledger entry.
([mutation dispatch and audit](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_manager_tool.py#L1576-L1709),
[tool schema](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_manager_tool.py#L1761-L1795))

This is permissive by default: `skills.write_approval: false` lets foreground and background Agent
writes land immediately. Enabling it stages every Skill mutation under
`$HERMES_HOME/pending/skills/` for `/skills diff`, approve, or reject; the review commands also work
on messaging surfaces.
([approval semantics](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L577-L608))

Chat slash commands also browse, inspect, install, update, and reset Hub Skills. Direct URL installs
are allowed, scanned as community content, and retain the URL as their update identifier.
([chat lifecycle commands](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L991-L1016),
[URL provenance](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L795-L821))

### Scripts, files, and cron jobs

An ordinary chat turn may use `write_file` for arbitrary allowed paths and then use `cronjob` to
create, update, pause, resume, run, or remove a schedule. Hermes explicitly documents the
chat-authored watchdog path: write a script into `$HERMES_HOME/scripts/`, then create a `no_agent`
job whose stdout is the delivered result.
([chat-created script jobs](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/cron.md#L624-L664),
[`cronjob` lifecycle](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/cron.md#L828-L862))

Hermes does not intend the Agent to patch `jobs.json` or `config.yaml` directly. The file tool
hard-blocks its active `config.yaml`, and the documentation routes cron and other control-state
changes through their supported APIs.
([config write refusal](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/file_tools.py#L667-L711),
[control-state rule](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L323-L329))

### MCP setup and imports

Desktop exposes a model tool named `setup_mcp`. When the user asks to install, enable, or authorize
an MCP, the Agent raises an inline card and blocks until the user approves, declines, or leaves it
unanswered. Outside Desktop, its defined fallback is the CLI.
([tool boundary and outcomes](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/setup_mcp_tool.py#L1-L15),
[`setup_mcp` contract](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/setup_mcp_tool.py#L74-L120))

The supported Desktop install path is deliberately narrower than arbitrary chat-directed import:
it accepts a reviewed catalog entry or a known official URL-only directory entry, prompts for
required credentials without pre-filling or echoing them, and reloads the live Agent tool snapshot
after success. An unknown name fails. For a directory entry, OAuth cancellation attempts to remove
the just-written configuration.
([Desktop validation and rollback](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L290-L373),
[reload before Agent continuation](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx#L194-L239))

Arbitrary custom stdio/HTTP MCP configuration remains a CLI/settings operation (`hermes mcp add`).
Likewise, `hermes import-agent` can import instructions, permission rules, MCP server definitions,
and Skills from Claude Code or Codex, but it is preview-first, skips conflicts unless explicitly
overwritten, and never imports credentials.
([custom MCP validation and save](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_config.py#L438-L505),
[import mapping and safety](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/import-from-other-agents.md#L20-L53))

## 3. Execution boundary, host access, and credentials

Hermes's local terminal backend has no isolation; Docker, Singularity, Modal, Daytona, and Vercel
Sandbox are the isolated options, while SSH moves execution to another machine. Persistent Docker
state lives in a per-task sandbox tree; ephemeral mode uses tmpfs.
([backend comparison](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L454-L515))

That terminal choice does not automatically contain the other executable extension paths. Stdio
MCP servers are spawned directly by the host MCP runtime, and cron scripts are launched by the
host scheduler with `subprocess.Popen`; neither is dispatched through the selected terminal
backend. Selecting Docker for Agent terminal calls therefore does not, by itself, sandbox an MCP
package or scheduled script.
([stdio MCP spawn](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_tool.py#L3183-L3258),
[cron script spawn](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L4393-L4419))

File tools block credential stores and can be constrained to one or more safe roots. That is only
defence in depth: the official documentation states that a local `terminal` runs as the same OS
user and can overwrite paths denied to `write_file`/`patch`.
([file denylist and safe roots](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L279-L321),
[terminal bypass caveat](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L323-L329))

Dangerous shell commands go through approvals, with headless cron denying them by default. A
hardline blocklist remains active even under YOLO or cron auto-approval, but the threat model is an
honest-but-wrong Agent, not an adversarial-process sandbox.
([approval defaults](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L24-L60),
[always-on floor](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L94-L139))

Project instruction files such as `AGENTS.md`, `CLAUDE.md`, `SOUL.md`, `.cursorrules`, and
project-local `.hermes` configuration require one-operation human approval on the file-tool path,
even in auto-approve mode; a non-interactive caller fails closed.
([protected-instruction gate](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/file_tools.py#L714-L740),
[approval behavior](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/file_tools.py#L843-L964))

Credentials follow capability-specific paths:

- Skill-required env values are requested only in a local interactive client; messaging tells the
  user to configure them locally. Once declared and set, they are explicitly passed to the Skill's
  terminal/code execution.
  ([Skill secret setup](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L268-L299))
- Cron script subprocesses strip Hermes-managed provider credentials, and the script must resolve
  inside `$HERMES_HOME/scripts/`, including after symlink resolution.
  ([script confinement and environment](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L4272-L4357))
- MCP stdio subprocesses receive only safe system variables plus the server's explicitly configured
  `env`; Skill passthrough does not apply to MCP.
  ([MCP environment isolation](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L583-L615))
- MCP OAuth artifacts are profile-scoped under `mcp-tokens/`; catalog API keys go to `.env`.
  ([OAuth file layout](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_oauth.py#L452-L482),
  [catalog credential policy](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_catalog.py#L9-L22))

An MCP server may be marked `trust: untrusted`. Hermes then requires one-call approval for every
tool that lacks an exact server-supplied `readOnlyHint: true`; missing or malformed annotations
fail closed to write-capable. Backward compatibility leaves an unspecified server at `full`, and a
server can lie in its hint, so this is useful friction rather than a strong effect system.
([MCP trust semantics](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_tool.py#L4575-L4644),
[call-time approval](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_tool.py#L4662-L4716))

## 4. MCP discovery, lifecycle, and provider relationship

`mcp_servers` entries describe stdio subprocesses or remote HTTP endpoints. Hermes connects and
discovers tools, applies per-server include/exclude filters, registers normalized tool schemas, and
may lazily restore schemas from a cache before starting a server. Disabled servers are not
connected or registered.
([discovery and lazy registration](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_tool.py#L7640-L7752),
[filter semantics](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_tool.py#L7158-L7223))

MCP is runtime-tool infrastructure, not an inference-provider feature. An `AIAgent` takes one tool
snapshot from the shared registry at construction; a reload or between-turn refresh rebuilds that
snapshot while respecting the session's toolset filters. Reloading invalidates the provider prompt
cache because tool schemas are part of the prompt, but changing the model provider does not own or
reinstall the MCP server.
([Agent tool snapshot](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/agent/agent_init.py#L1590-L1627),
[MCP snapshot refresh](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/mcp_tool.py#L8140-L8189),
[prompt-cache consequence](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/security.md#L44-L51))

The curated catalog has a stronger supply-chain story than custom MCPs: entries enter the official
tree by PR, package launchers pin exact versions, git installs pin full SHAs, and updates are never
automatic. Installation may nevertheless execute `git clone`, arbitrary manifest bootstrap shell
commands, and the MCP server's code.
([catalog pins and update policy](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_catalog.py#L1-L22),
[bootstrap execution](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_catalog.py#L461-L547))

Lifecycle gaps remain:

- reinstall deletes the previous git install before cloning and bootstrapping the replacement;
- explicit reinstall is the update operation; there is no MCP auto-update;
- catalog uninstall removes configuration and cloned files but preserves `.env` credentials for
  manual cleanup;
- the generic `hermes mcp remove` path also removes OAuth tokens, so removal semantics differ;
- **observed absence:** no MCP install rollback ledger or transactional restoration of the previous
  clone was found in the inspected catalog flow.

([install/reinstall flow](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_catalog.py#L483-L547),
[catalog uninstall](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_catalog.py#L979-L1000),
[credential-preserving UI](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_picker.py#L194-L225),
[generic removal cleanup](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/hermes_cli/mcp_config.py#L643-L672))

## 5. What a cron job actually binds

Hermes stores a self-contained prompt plus optional ordered Skill names, a script path, toolset
names, working directory, and delivery information. It can pin a model/provider, but those pins are
explicitly user-owned and are not accepted from the Agent's `cronjob` arguments. An unpinned job
records model/provider defaults and fails closed after unexpected drift.
([job schema](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/cronjob_tools.py#L1951-L2028),
[Agent cannot set inference pins](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/cronjob_tools.py#L2069-L2093),
[model drift policy](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/cron.md#L24-L35))

The remaining dependencies are live references:

- **Skills:** the job stores names. At each run the scheduler calls `skill_view`, loads current
  content in order, and skips missing Skills with a user-visible warning. It stores no Skill
  version or content hash.
  ([run-time Skill resolution](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L4723-L4808))
- **Scripts:** the job stores a path. At each tick Hermes resolves the path within
  `$HERMES_HOME/scripts/` and executes the file currently at that location. It stores no script
  digest or revision.
  ([run-time script resolution](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L4272-L4392))
- **MCP:** the scheduler discovers the currently configured MCP registry before constructing the
  Agent. A per-job native-toolset restriction still unions in every globally enabled MCP server
  unless the job names one or more MCP servers as an allowlist or uses `no_mcp`.
  ([cron MCP discovery](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L6330-L6349),
  [per-job MCP merge](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L498-L550))
- **Tools and policy:** the fresh cron Agent resolves its current platform/per-job toolsets and the
  current global disabled set. Messaging and clarification are always excluded; recursive cron
  creation is disabled unless an operator enables it.
  ([cron tool policy](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L464-L495),
  [fresh Agent construction](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L6402-L6439))

This makes Skill and MCP updates immediately available to future runs, but it also means a confirmed
job can change behavior without its own definition changing. Catalog SHA/version pins constrain the
installed MCP payload at one moment; they are not copied into the cron record. Hermes does scan the
fully assembled prompt, including loaded Skill content, before a headless run, and preflight can
block missing Skill credentials without spending model tokens.
([assembled-prompt security check](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/cron/scheduler.py#L451-L460),
[pre-dispatch checks](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/cron.md#L74-L99))

## 6. Provenance, removal, and rollback

Research 16's lifecycle findings remain valid: Hub Skill installs record source, hash, scanner
evidence, and local-drift state; updates skip locally modified packages unless forced; bundled
Skills use an origin-hash manifest and can be reset or restored.
([Hub update provenance](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L833-L846),
[bundled reset](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/skills.md#L965-L999))

One additional mechanism matters for chat-directed editing: every successful `skill_manage`
mutation is intended to append an actor-tagged JSONL record with before/after content-addressed
blobs. `hermes curator rollback <entry-id>` restores one mutation after first recording a safety
entry, so that rollback is itself reversible. The ledger is telemetry, not a gate: failure to
record does not block the original write.
([ledger scope and storage](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_ledger.py#L1-L24),
[rollback checks](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_ledger.py#L288-L387))

There is no equivalent dependency manifest or rollback record on each cron job. Skill provenance,
MCP provenance, script contents, and scheduler state live in separate subsystems; the run does not
materialize them into one Automation revision.

## 7. Core files and self-modification

Hermes's advertised autonomous self-improvement loop is limited to memory and Skills. The
background-review fork inherits the model/runtime but receives only memory and Skill-management
tools; other tools are denied. Its Skill guard also refuses autonomous changes to pinned,
external, Hub-installed, bundled, protected built-in, or non-curator-owned Skills.
([background-review boundary](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/agent/background_review.py#L1-L16),
[autonomous Skill ownership guard](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_manager_tool.py#L335-L455))

The essential `hermes-agent` operating-manual Skill has a narrower protection: it cannot be
deleted, but a foreground user-directed turn may still patch or replace it.
([essential-Skill guard](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_manager_tool.py#L294-L316))

That is not a general immutable-core boundary. In a normal user-directed coding turn, ordinary
source files can be changed wherever the selected backend and filesystem permissions allow.
`config.yaml` and credential files have dedicated file-tool guards, and instruction files require
approval, but the local terminal still has the OS user's access. On Windows only, Hermes blocks git
operations that would rewrite the live source checkout; the guard is deliberately inactive on
POSIX.
([self-repository platform boundary](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/self_repo_guard.py#L698-L726),
[terminal enforcement](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/terminal_tool.py#L3201-L3231))

Core updates are a separate, explicit product operation: `/update` or `hermes update` pulls code,
updates dependencies, migrates configuration, and restarts gateways. It snapshots profile state and
rolls the source checkout back automatically only when critical post-pull syntax validation fails;
manual commit rollback remains documented.
([update transaction](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/getting-started/updating.md#L23-L32),
[chat update command](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/getting-started/updating.md#L203-L211),
[manual code rollback](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/getting-started/updating.md#L234-L260))

**Observed absence:** no autonomous loop that patches Hermes core source, installs a new arbitrary
MCP, or changes its own security configuration was found. Hermes can still act as a general coding
Agent when the user explicitly asks it to edit a checkout; that ordinary tool authority should not
be confused with its narrowly scoped self-improvement loop.

## 8. Changes since Research 16's pinned revision

The main architecture above is unchanged from `13ce0c5`: `/learn`, `setup_mcp`, Skill staging and
rollback, cron Skill-name resolution, and the MCP trust tier already existed. Four later changes
are material to this question:

1. **Profiles are now explicitly non-isolation boundaries.** The prior file-tool soft guard against
   writes into another profile was removed; current code says profiles share an OS user and the
   terminal could already write anywhere. Only sandbox-mirror lost-write detection remains.
   ([current rationale](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/file_tools.py#L1066-L1084),
   [comparison](https://github.com/NousResearch/hermes-agent/compare/13ce0c5c675e843af70d19c9e5144249cd51c8d1...7b5e1911f88be05eb5f9ce34453149dddd95ced3))
2. **Cron gained a user-owned per-job reasoning-effort pin.** Like model/provider pins, it is kept
   out of the Agent-facing `cronjob` tool; this strengthens cost/runtime control but does not pin
   Skills, scripts, or MCPs.
   ([reasoning pin](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/cron.md#L24-L35))
3. **The MCP catalog gained exclude-mode defaults for very large tool surfaces.** Such an install
   enables present and future tools except matched exclusions, and reinstall preserves a user's
   prior include/exclude choice. This improves operability but increases future-capability drift
   compared with an explicit allowlist.
   ([exclude-mode behavior](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/website/docs/user-guide/features/mcp.md#L89-L126))
4. **The essential operating-manual Skill gained deletion protection.** The current guard prevents
   deletion of `hermes-agent`, but expressly leaves patches and edits available; this protects a
   required reference, not the integrity of its instructions.
   ([current deletion guard](https://github.com/NousResearch/hermes-agent/blob/7b5e1911f88be05eb5f9ce34453149dddd95ced3/tools/skill_manager_tool.py#L294-L316))

## Implications for Veduta Q4

### Practices worth borrowing

- Make natural conversation the front door, but route mutations through typed operations: create
  an Automation, install a Connection/capability, write a reviewed support asset, request a secret,
  or update an existing revision.
- Give each profile/installation a dedicated extension area, with separate stores for settings,
  secrets, executable assets, installed capabilities, pending changes, provenance, and audit.
- Keep credentials out of chat. Collect them in a local trusted UI, store references rather than
  values in Automation definitions, and inject only the minimum secret set into the selected
  execution boundary.
- Use preview → explicit consent → install → probe → select allowed operations → reload as the MCP
  installation flow. The consent view should show source, pinned revision, commands that will run,
  permissions, data egress, and destination scope.
- Record every Agent-created or imported file with actor, source, content hash, before/after state,
  and a reversible revision. Make audit failure fail closed for security-sensitive mutations,
  unlike Hermes's best-effort Skill ledger.
- Keep the confirmed Automation—not a Skill or chat transcript—as owner of trigger, Space scope,
  operation, Connection set, output destination, and Approval policy. Resolve an immutable
  dependency manifest when it is confirmed and record the exact manifest again in every Trace.
- Preserve Hermes's separation between provider selection and tool capability. A model/provider may
  be replaced only if it still satisfies the Automation's required tool-call contract and explicit
  cost policy.
- Support both an Agent run and a script-only fast path, but run both inside the same constrained,
  observable Automation boundary and append every resulting mutation to the Space's Event log.

### Risks not to copy

- Do not treat a same-user local shell as a sandbox, or let terminal commands bypass file,
  credential, Connection, and core-write policy.
- Do not make Agent-authored executable or Skill changes immediate by default. Stage, diff, test,
  approve, and version them before an unattended Automation can use them.
- Do not let an Automation silently inherit all globally enabled MCPs or future tools admitted by
  an exclusion list. Store a positive, least-privilege capability allowlist.
- Do not bind Skills by mutable name, scripts by mutable path, or MCPs by current global config.
  Pin content hashes and compatible versions, and require an explicit migration when behavior or
  authority changes.
- Do not use an MCP server's self-declared `readOnlyHint` as the authority model. Veduta should own
  typed effects and Approval requirements independently of server claims.
- Do not leave credentials behind silently after removing a Connection, and do not delete the old
  install before the replacement is verified. Use transactional install/update and explicit secret
  retention or revocation choices.
- Do not make core source or security policy part of the Agent-writable extension area. A personal
  Agent can be highly flexible without being able to rewrite the runtime that enforces its
  permissions.

For the motivating job-search example, the horizontal feature is therefore not “a LinkedIn cron.”
It is a chat-authored, versioned Automation that may combine Mailbox reads, a reviewed
website-reading capability or MCP Connection, an Agent-created transformation asset, and a Notion
(or Surface) destination. The
user approves that resolved composition once; subsequent runs remain reproducible, least-privilege,
observable, and migratable even as the underlying catalog evolves.
